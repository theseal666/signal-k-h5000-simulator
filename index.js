const dgram = require('dgram');

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

  // Active Environmental & Performance states
  let currentTWSRegime = 14.0;
  const orcWindSpectrum = [4, 6, 8, 10, 12, 14, 16, 20, 24];
  
  let orcTargetSTW = 5.85;   
  let orcTargetAngle = 37.8; 
  let randomVarianceScalar = 0.95; 

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

    // Instantly sync matrices from registry on save apply
    fetchOrcPolarMatrixByName(searchName, searchCountry);

    if (options.enableSimulation) {
      simInterval = setInterval(() => {
        generateAndBroadcastNMEA();
      }, 100);
    }
  };

  async function fetchOrcPolarMatrixByName(yachtName, countryId) {
    const url = `https://data.orc.org/public/WPub.dll?action=DownBoatRMS&YachtName=${encodeURIComponent(yachtName)}&CountryId=${encodeURIComponent(countryId)}&ext=json`;
    
    try {
      app.debug(`Simulator querying live official ORC endpoint: ${url}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      const response = await fetch(url, { signal: controller.signal });
      let data = await response.json();
      clearTimeout(timeoutId);
      
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
    } catch (err) {
      app.error(`Simulator live ORC network synchronization failed: ${err.message}`);
    }
  }

  function resolveActivePolarTarget(twsKnots) {
    if (!options.polarData) return;
    try {
      const allowances = options.polarData;
      const isGybeMode = options.maneuverMode === 'gybe';
      
      const windSpeeds = allowances.WindSpeeds || orcWindSpectrum;
      let targetIdx = windSpeeds.indexOf(twsKnots);
      if (targetIdx === -1) {
        // Fallback to nearest index match logic if wind isn't precisely sitting on an array boundary
        targetIdx = windSpeeds.reduce((prev, curr, idx) => 
          Math.abs(curr - twsKnots) < Math.abs(windSpeeds[prev] - twsKnots) ? idx : prev, 0);
      } 

      if (!isGybeMode) {
        const beatAngles = allowances.BeatAngle || [46, 43, 40.5, 38.8, 37.8, 37.8, 37.4, 37.3, 38.1];
        const beatSecondsPerMile = allowances.Beat || [1200.2, 855.1, 713.4, 654.3, 631.4, 615.5, 605.5, 595.9, 599.2];
        
        orcTargetAngle = beatAngles[targetIdx] || 37.8;
        const allowanceValue = beatSecondsPerMile[targetIdx] || 615.5;
        orcTargetSTW = 3600 / allowanceValue;
      } else {
        const gybeAngles = allowances.GybeAngle || [139.2, 142.1, 145.6, 148.2, 152.8, 152.0, 150.1, 144.8, 144.4];
        const runSecondsPerMile = allowances.Run || [1235.2, 850.1, 673.7, 571.0, 510.4, 476.4, 445.2, 371.7, 291.0];
        
        orcTargetAngle = gybeAngles[targetIdx] || 152.0;
        const allowanceValue = runSecondsPerMile[targetIdx] || 476.4;
        orcTargetSTW = 3600 / allowanceValue;
      }
    } catch (e) {
      app.error(`Error calculating ORC allowance matrix targets: ${e.message}`);
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
      
      // 3. Recalculate speeds with new wind rules applied
      resolveActivePolarTarget(currentTWSRegime); 
      app.debug(`[Environmental Update Step] Wind Shifted: ${currentTWSRegime} kn | Target Performance Load: ${(randomVarianceScalar * 100).toFixed(1)}%`);
    }

    let isGybeMode = options.maneuverMode === 'gybe';
    let activeTargetAngle = orcTargetAngle;
    let activeTargetSTW = orcTargetSTW;

    let baseSTWKnots = activeTargetSTW * randomVarianceScalar;
    let simulatedTWSKnots = currentTWSRegime; 
    let simulatedTWADeg = activeTargetAngle; 

    let totalLoopTicks = (options.maneuverInterval || 45) * 10;
    let loopStep = simStep % totalLoopTicks;

    if (loopStep === 0 && simStep > 1) {
      isCurrentlyStarboard = !isCurrentlyStarboard;
    }

    let side = isCurrentlyStarboard ? 1 : -1;
    let entryAwa = activeTargetAngle * side;  
    let exitAwa = -activeTargetAngle * side; 
    let dynamicOvershootAwa = isGybeMode ? -((activeTargetAngle - 10) * side) : -((activeTargetAngle + 10) * side); 

    let currentSTWKnots = baseSTWKnots;
    let currentAWADeg = entryAwa;
    let currentRudderDeg = 0.0;

    if (isGybeMode) {
      if (loopStep >= 0 && loopStep < 30) {
        let progress = loopStep / 30;
        currentRudderDeg = -5 * side * progress; 
        let targetBoundary = 180 * side;
        currentAWADeg = entryAwa + ((targetBoundary - entryAwa) * progress);
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
        
        if (rawSweep > 180) currentAWADeg = rawSweep - 360;
        else if (rawSweep < -180) currentAWADeg = rawSweep + 360;
        else currentAWADeg = rawSweep;
        
        let maxSpeedDrop = baseSTWKnots * 0.25;
        currentSTWKnots = (baseSTWKnots * 0.90) - (maxSpeedDrop * Math.sin(progress * Math.PI / 2));
      }
      else if (loopStep >= 70 && loopStep < 170) {
        let progress = (loopStep - 70) / 100;
        currentRudderDeg = 4 * side * (1 - progress); 
        currentAWADeg = dynamicOvershootAwa + ((exitAwa - dynamicOvershootAwa) * Math.pow(progress, 2));
        let lowestSpeed = baseSTWKnots * 0.65;
        currentSTWKnots = lowestSpeed + ((baseSTWKnots - lowestSpeed) * Math.sqrt(progress));
      }
      else {
        currentRudderDeg = 0.0;
        currentAWADeg = exitAwa;
        currentSTWKnots = baseSTWKnots;
      }
      simulatedTWADeg = Math.abs(currentAWADeg);
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
        let maxSpeedDrop = baseSTWKnots * 0.45;
        currentSTWKnots = (baseSTWKnots * 0.85) - (maxSpeedDrop * Math.sin(progress * Math.PI / 2));
      }
      else if (loopStep >= 70 && loopStep < 170) {
        let progress = (loopStep - 70) / 100;
        currentRudderDeg = -2 * side * (1 - progress);
        currentAWADeg = dynamicOvershootAwa + ((exitAwa - dynamicOvershootAwa) * Math.pow(progress, 2));
        let lowestSpeed = baseSTWKnots * 0.40;
        currentSTWKnots = lowestSpeed + ((baseSTWKnots - lowestSpeed) * Math.sqrt(progress));
      }
      else {
        currentRudderDeg = 0.0;
        currentAWADeg = exitAwa;
        currentSTWKnots = baseSTWKnots;
      }
      simulatedTWADeg = Math.abs(currentAWADeg);
    }

    let twaRadians = (simulatedTWADeg * Math.PI) / 180;
    let computedVMGKnots = Math.abs(currentSTWKnots * Math.cos(twaRadians));

    let vhw = `IIVHW,,T,,M,${currentSTWKnots.toFixed(2)},N,,K`;
    let vhwSentence = appendChecksum(vhw);

    let awaFormatted = currentAWADeg < 0 ? 360 + currentAWADeg : currentAWADeg;
    let mwvApparent = `IIMWV,${awaFormatted.toFixed(1)},R,${simulatedTWSKnots.toFixed(1)},N,A`;
    let mwvApparentSentence = appendChecksum(mwvApparent);

    let rudderStr = currentRudderDeg.toFixed(1);
    let rsa = `IIRSA,${rudderStr},A,,`;
    let rsaSentence = appendChecksum(rsa);

    let twaFormatted = currentAWADeg < 0 ? 360 - simulatedTWADeg : simulatedTWADeg;
    let mwvTrue = `IIMWV,${twaFormatted.toFixed(1)},T,${simulatedTWSKnots.toFixed(1)},N,A`;
    let mwvTrueSentence = appendChecksum(mwvTrue);

    let vmgSentenceText = `IIVMG,${computedVMGKnots.toFixed(2)},N,,`;
    let vmgSentence = appendChecksum(vmgSentenceText);

    const payload = `${vhwSentence}\r\n${mwvApparentSentence}\r\n${mwvTrueSentence}\r\n${vmgSentence}\r\n${rsaSentence}\r\n`;
    udpClient.send(payload, 2222, '127.0.0.1');
  }

  function appendChecksum(sentenceWithoutSign) {
    let checksum = 0;
    for (let i = 0; i < sentenceWithoutSign.length; i++) {
      checksum ^= sentenceWithoutSign.charCodeAt(i);
    }
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