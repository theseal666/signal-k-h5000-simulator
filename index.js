const dgram = require('dgram');
const https = require('https');

module.exports = function (app) {
  const plugin = {};
  let simInterval = null;
  let options = {};
  const udpClient = dgram.createSocket('udp4');

  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator (UDP Sentences)';
  plugin.description = 'Broadcasts high-frequency simulated NMEA 0183 sentences over UDP port 2222 by dynamically parsing live ORC database certificates with live config reload, dynamic wind stepping, and performance scalar integration.';

  let simStep = 0;
  let isCurrentlyStarboard = true;
  let verifiedVesselName = 'None - Waiting for valid API sync...';
  let verifiedCertRef = 'None';

  // Environmental Tracking & Target Matrices
  let currentTWSRegime = 14.0;
  const orcWindSpectrum = [4, 6, 8, 10, 12, 14, 16, 20, 24];
  
  let orcTargetSTW = 5.85;   
  let orcTargetAngle = 37.8; 
  let randomVarianceScalar = 0.95; 

  // Damping States to mimic B&G H5000 processing delays
  let filteredVMG = 0.0;
  const dampingFactor = 0.033; // ~3-second damping window at 10Hz output

  plugin.start = function (startOptions) {
    // Clear any active intervals if start is triggered during a live configuration save reload
    if (simInterval) {
      clearInterval(simInterval);
      simInterval = null;
    }

    options = startOptions || {};
    isCurrentlyStarboard = true;

    if (options.lastVerifiedVessel) {
      verifiedVesselName = options.lastVerifiedVessel;
      plugin.schema.properties.lastVerifiedVessel.default = verifiedVesselName;
    }
    if (options.lastVerifiedCert) {
      verifiedCertRef = options.lastVerifiedCert;
      plugin.schema.properties.lastVerifiedCert.default = verifiedCertRef;
    }

    const searchName = options.orcYachtName ? options.orcYachtName.trim() : 'Karukera';
    const searchCountry = options.orcCountryId ? options.orcCountryId.trim() : 'SWE';

    // Instantly sync matrices from registry on save apply without requiring a container restart
    fetchOrcPolarMatrixByName(searchName, searchCountry);

    if (options.enableSimulation) {
      simInterval = setInterval(() => {
        generateAndBroadcastNMEA();
      }, 100);
    }
  };

  function fetchOrcPolarMatrixByName(yachtName, countryId) {
    const url = `https://data.orc.org/public/WPub.dll?action=DownBoatRMS&YachtName=${encodeURIComponent(yachtName)}&CountryId=${encodeURIComponent(countryId)}&ext=json`;
    
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          let recordArray = data && data.rms ? data.rms : (Array.isArray(data) ? data : []);

          if (recordArray.length > 0) {
            const activeBoatRecord = recordArray[0];
            
            if (activeBoatRecord.Allowances) {
              options.polarData = activeBoatRecord.Allowances;
              
              const craftName = activeBoatRecord.YachtName || yachtName;
              const sailNum = activeBoatRecord.SailNo || '';
              
              verifiedVesselName = sailNum ? `${craftName} (${sailNum})` : craftName;
              plugin.schema.properties.lastVerifiedVessel.default = verifiedVesselName;
              
              verifiedCertRef = activeBoatRecord.RefNo || 'Found';
              plugin.schema.properties.lastVerifiedCert.default = verifiedCertRef;
              
              if (options.lastVerifiedVessel !== verifiedVesselName || options.lastVerifiedCert !== verifiedCertRef) {
                options.lastVerifiedVessel = verifiedVesselName;
                options.lastVerifiedCert = verifiedCertRef;
                app.savePluginOptions(options, () => {
                  app.debug(`[Live Configuration Update] Loaded Matrix: ${verifiedVesselName} | Cert: ${verifiedCertRef}`);
                });
              }

              resolveActivePolarTarget(currentTWSRegime); 
            } else {
              app.error(`Matched record structure, but Allowances data map was absent.`);
            }
          } else {
            app.error(`No active certification criteria matched on the database server for: ${yachtName} (${countryId})`);
          }
        } catch (e) {
          app.error(`Failed parsing target polar data from registry: ${e.message}`);
        }
      });
    }).on('error', (err) => app.error(`Simulator live ORC network synchronization failed: ${err.message}`));
  }

  function resolveActivePolarTarget(twsKnots) {
    if (!options.polarData) return;
    const allowances = options.polarData;
    const isGybeMode = options.maneuverMode === 'gybe';
    const windSpeeds = allowances.WindSpeeds || orcWindSpectrum;
    
    let targetIdx = windSpeeds.indexOf(twsKnots);
    if (targetIdx === -1) {
      targetIdx = windSpeeds.reduce((prev, curr, idx) => 
        Math.abs(curr - twsKnots) < Math.abs(windSpeeds[prev] - twsKnots) ? idx : prev, 0);
    } 

    if (!isGybeMode) {
      const beatAngles = allowances.BeatAngle || [46, 43, 40.5, 38.8, 37.8, 37.8, 37.4, 37.3, 38.1];
      const beatSecondsPerMile = allowances.Beat || [1200.2, 855.1, 713.4, 654.3, 631.4, 615.5, 605.5, 595.9, 599.2];
      orcTargetAngle = beatAngles[targetIdx] || 37.8;
      orcTargetSTW = 3600 / (beatSecondsPerMile[targetIdx] || 615.5);
    } else {
      const gybeAngles = allowances.GybeAngle || [139.2, 142.1, 145.6, 148.2, 152.8, 152.0, 150.1, 144.8, 144.4];
      const runSecondsPerMile = allowances.Run || [1235.2, 850.1, 673.7, 571.0, 510.4, 476.4, 445.2, 371.7, 291.0];
      orcTargetAngle = gybeAngles[targetIdx] || 152.0;
      orcTargetSTW = 3600 / (runSecondsPerMile[targetIdx] || 476.4);
    }
  }

  function generateAndBroadcastNMEA() {
    simStep++;
    
    // Performance Step Scalar Interval processing logic
    let performanceUpdateTicks = (options.perfUpdateInterval || 5) * 10; 
    if (simStep % performanceUpdateTicks === 1 || simStep === 1) {
      // 1. Shift environment to a new target speed regime out of the parsed matrix array
      let currentIdx = orcWindSpectrum.indexOf(currentTWSRegime);
      let nextIdx = (currentIdx + 1) % orcWindSpectrum.length;
      currentTWSRegime = orcWindSpectrum[nextIdx];

      // 2. Compute randomized variance performance filter target percentage
      let minPerf = (options.minPerformance || 92) / 100;
      let maxPerf = (options.maxPerformance || 98) / 100;
      randomVarianceScalar = minPerf + (Math.random() * (maxPerf - minPerf));
      
      // 3. Recalculate targets with new wind rules applied
      resolveActivePolarTarget(currentTWSRegime); 
      app.debug(`[Wind Step Update] Wind Shifted: ${currentTWSRegime} kn | Target Performance Load: ${(randomVarianceScalar * 100).toFixed(1)}%`);
    }

    let isGybeMode = options.maneuverMode === 'gybe';
    let baseSTWKnots = orcTargetSTW * randomVarianceScalar;

    let totalLoopTicks = (options.maneuverInterval || 45) * 10;
    let loopStep = simStep % totalLoopTicks;

    if (loopStep === 0 && simStep > 1) {
      isCurrentlyStarboard = !isCurrentlyStarboard;
    }

    let side = isCurrentlyStarboard ? 1 : -1;
    let entryAwa = orcTargetAngle * side;  
    let exitAwa = -orcTargetAngle * side; 
    let dynamicOvershootAwa = isGybeMode ? -((orcTargetAngle - 10) * side) : -((orcTargetAngle + 10) * side); 

    let currentSTWKnots = baseSTWKnots;
    let currentAWADeg = entryAwa;
    let currentRudderDeg = 0.0;

    // Maneuver Turn Logic Sourced from Live Polar Angle Targets
    if (isGybeMode) {
      if (loopStep >= 0 && loopStep < 30) {
        let progress = loopStep / 30;
        currentRudderDeg = -5 * side * progress; 
        currentAWADeg = entryAwa + (((180 * side) - entryAwa) * progress);
        currentSTWKnots = baseSTWKnots - ((baseSTWKnots * 0.10) * progress);
      }
      else if (loopStep >= 30 && loopStep < 70) {
        let progress = (loopStep - 30) / 40;
        currentRudderDeg = -12 * side; 
        let startAngle = 180 * side;
        let targetEndUnwrapped = dynamicOvershootAwa;
        if (side === 1 && targetEndUnwrapped < 0) targetEndUnwrapped += 360;
        if (side === -1 && targetEndUnwrapped > 0) targetEndUnwrapped -= 360;
        let rawSweep = startAngle + ((targetEndUnwrapped - startAngle) * progress);
        currentAWADeg = rawSweep > 180 ? rawSweep - 360 : (rawSweep < -180 ? rawSweep + 360 : rawSweep);
        currentSTWKnots = (baseSTWKnots * 0.90) - ((baseSTWKnots * 0.25) * Math.sin(progress * Math.PI / 2));
      }
      else if (loopStep >= 70 && loopStep < 170) {
        let progress = (loopStep - 70) / 100;
        currentRudderDeg = 4 * side * (1 - progress); 
        currentAWADeg = dynamicOvershootAwa + ((exitAwa - dynamicOvershootAwa) * Math.pow(progress, 2));
        currentSTWKnots = (baseSTWKnots * 0.65) + ((baseSTWKnots - (baseSTWKnots * 0.65)) * Math.sqrt(progress));
      }
      else {
        currentAWADeg = exitAwa;
      }
    } else {
      if (loopStep >= 0 && loopStep < 30) {
        let progress = loopStep / 30;
        currentRudderDeg = 6 * side * progress;
        currentAWADeg = entryAwa + ((0 - entryAwa) * progress);
        currentSTWKnots = baseSTWKnots - ((baseSTWKnots * 0.15) * progress);
      }
      else if (loopStep >= 30 && loopStep < 70) {
        let progress = (loopStep - 30) / 40;
        currentRudderDeg = 10 * side;
        currentAWADeg = 0 + ((dynamicOvershootAwa - 0) * progress);
        currentSTWKnots = (baseSTWKnots * 0.85) - ((baseSTWKnots * 0.45) * Math.sin(progress * Math.PI / 2));
      }
      else if (loopStep >= 70 && loopStep < 170) {
        let progress = (loopStep - 70) / 100;
        currentRudderDeg = -2 * side * (1 - progress);
        currentAWADeg = dynamicOvershootAwa + ((exitAwa - dynamicOvershootAwa) * Math.pow(progress, 2));
        currentSTWKnots = (baseSTWKnots * 0.40) + ((baseSTWKnots - (baseSTWKnots * 0.40)) * Math.sqrt(progress));
      }
      else {
        currentAWADeg = exitAwa;
      }
    }

    // Apparent Wind Angle Vector Calculations
    let awaRad = (currentAWADeg * Math.PI) / 180;
    let awsKnots = currentTWSRegime; 
    
    let apparentX = awsKnots * Math.cos(awaRad) - currentSTWKnots;
    let apparentY = awsKnots * Math.sin(awaRad);
    let derivedTWADeg = Math.abs(Math.atan2(apparentY, apparentX) * 180 / Math.PI);

    // Compute unfiltered dynamic VMG
    let twaRad = (derivedTWADeg * Math.PI) / 180;
    let rawVMGKnots = Math.abs(currentSTWKnots * Math.cos(twaRad));
    
    // Instrument Damping Filter (Prevents immediate zeroing on tacks)
    filteredVMG = filteredVMG + dampingFactor * (rawVMGKnots - filteredVMG);

    // Assembly
    let vhwSentence = appendChecksum(`IIVHW,,T,,M,${currentSTWKnots.toFixed(2)},N,,K`);
    
    let awaFormatted = currentAWADeg < 0 ? 360 + currentAWADeg : currentAWADeg;
    let mwvApparentSentence = appendChecksum(`IIMWV,${awaFormatted.toFixed(1)},R,${awsKnots.toFixed(1)},N,A`);

    let twaFormatted = currentAWADeg < 0 ? 360 - derivedTWADeg : derivedTWADeg;
    let mwvTrueSentence = appendChecksum(`IIMWV,${twaFormatted.toFixed(1)},T,${currentTWSRegime.toFixed(1)},N,A`);
    
    let vmgSentence = appendChecksum(`IIVMG,${filteredVMG.toFixed(2)},N,,`);
    let rsaSentence = appendChecksum(`IIRSA,${currentRudderDeg.toFixed(1)},A,,`);

    const payload = `${vhwSentence}\r\n${mwvApparentSentence}\r\n${mwvTrueSentence}\r\n${vmgSentence}\r\n${rsaSentence}\r\n`;
    udpClient.send(payload, 2222, '127.0.0.1');
  }

  function appendChecksum(sentenceWithoutSign) {
    let checksum = 0;
    for (let i = 0; i < sentenceWithoutSign.length; i++) checksum ^= sentenceWithoutSign.charCodeAt(i);
    return `$${sentenceWithoutSign}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
  }

  plugin.stop = function () {
    if (simInterval) clearInterval(simInterval);
  };

  plugin.schema = {
    type: 'object',
    title: 'H5000 Network UDP Simulator Controls',
    properties: {
      enableSimulation: { type: 'boolean', title: 'Enable Simulator Output Feed', default: false },
      maneuverMode: { 
        type: 'string', 
        title: 'Maneuver Simulation Track Target', 
        default: 'tack',
        enum: ['tack', 'gybe'],
        enumNames: ['Tacking (Upwind Testing Sequence)', 'Gybing (Downwind Testing Sequence)']
      },
      maneuverInterval: { type: 'number', title: 'Maneuver Interval Cycles (Seconds)', default: 45 },
      perfUpdateInterval: { type: 'number', title: 'Performance Scalar Step Changes (Seconds)', default: 5 },
      orcYachtName: { type: 'string', title: 'ORC Yacht Name Lookup Field', default: 'Karukera' },
      orcCountryId: { type: 'string', title: 'ORC Country Prefix Code', default: 'SWE' },
      lastVerifiedVessel: { 
        type: 'string', 
        title: 'Active Verified Vessel Status', 
        default: 'None - Waiting for valid API sync...',
        readonly: true 
      },
      lastVerifiedCert: { 
        type: 'string', 
        title: 'Live Verified Certificate #', 
        description: 'The real-time reference ID returned by the ORC registry.',
        default: 'None',
        readonly: true 
      },
      minPerformance: { type: 'number', title: 'Minimum Target Performance Filter Range (%)', default: 92 },
      maxPerformance: { type: 'number', title: 'Maximum Target Performance Filter Range (%)', default: 98 }
    }
  };

  return plugin;
};