const dgram = require('dgram');

module.exports = function (app) {
  const plugin = {};
  let simInterval = null;
  let options = {};
  const udpClient = dgram.createSocket('udp4');

  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator (UDP Sentences)';
  plugin.description = 'Broadcasts high-frequency simulated NMEA 0183 sentences over UDP port 2222 by dynamically parsing live ORC database certificate VPP matrices.';

  let simStep = 0;
  let isCurrentlyStarboard = true;
  let verifiedVesselName = 'None - Waiting for valid API sync...';
  let verifiedCertRef = 'None';

  // Base internal fallbacks (Calculated from Karukera's 14kt target benchmarks)
  let orcTargetSTW = 5.85;   
  let orcTargetAngle = 37.8; 
  let randomVarianceScalar = 0.95; 

  plugin.start = function (startOptions) {
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

    const searchName = options.orcYachtName ? options.orcYachtName.trim() : '';
    const searchCountry = options.orcCountryId ? options.orcCountryId.trim() : '';

    if (searchName && searchCountry) {
      fetchOrcPolarMatrixByName(searchName, searchCountry);
    }
  };

  async function fetchOrcPolarMatrixByName(yachtName, countryId) {
    // URL structured exactly as requested to query using Name and Country
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
        const vppBlock = activeBoatRecord.vpp || activeBoatRecord;
        
        if (vppBlock) {
          options.polarData = vppBlock;
          
          const craftName = activeBoatRecord.YachtName || activeBoatRecord.yachtName || yachtName;
          const sailNum = activeBoatRecord.SailNo || activeBoatRecord.sailNo || '';
          
          verifiedVesselName = sailNum ? `${craftName} (${sailNum})` : craftName;
          plugin.schema.properties.lastVerifiedVessel.default = verifiedVesselName;
          
          // Capture and verify the certificate reference number from the object response
          verifiedCertRef = activeBoatRecord.RefNo || activeBoatRecord.refNo || 'Found';
          plugin.schema.properties.lastVerifiedCert.default = verifiedCertRef;
          
          // Persist back to configurations schema storage if anything changed
          if (options.lastVerifiedVessel !== verifiedVesselName || options.lastVerifiedCert !== verifiedCertRef) {
            options.lastVerifiedVessel = verifiedVesselName;
            options.lastVerifiedCert = verifiedCertRef;
            app.savePluginOptions(options, () => {
              app.debug(`[ORC Config UI Sync] Found ${verifiedVesselName} | Cert Verification: ${verifiedCertRef}`);
            });
          }

          app.debug(`[ORC Engine Init] Successfully bound VPP polar matrices for boat reference: ${verifiedCertRef}`);
          resolveActivePolarTarget(14.0); 
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
      const vpp = options.polarData;
      const isGybeMode = options.maneuverMode === 'gybe';
      
      let targetArray = isGybeMode ? vpp.vmgDownwind : vpp.vmgUpwind;
      
      if (targetArray && Array.isArray(targetArray)) {
        let match = targetArray.find(item => twsKnots <= (item.tws || item.TWS || 0));
        if (!match) match = targetArray[targetArray.length - 1];
        
        if (match) {
          if (isGybeMode) {
            orcTargetSTW = match.vboat || match.VBoat || match.speed || 8.71;
            orcTargetAngle = match.downwindAngle || match.angle || match.twa || 152.0;
          } else {
            orcTargetSTW = match.vboat || match.VBoat || match.speed || 5.85;
            orcTargetAngle = match.upwindAngle || match.angle || match.twa || 37.8;
          }
          app.debug(`[ORC Polar Update] Live Targets -> STW: ${orcTargetSTW.toFixed(2)} kn | Wind Angle: ${orcTargetAngle.toFixed(1)}°`);
        }
      } else {
        // Safe defaults if arrays aren't matched cleanly
        if (isGybeMode) {
          orcTargetSTW = 8.71;   
          orcTargetAngle = 152.0; 
        } else {
          orcTargetSTW = 5.85;   
          orcTargetAngle = 37.8;  
        }
      }
    } catch (e) {
      app.error(`Error processing live VPP target properties array: ${e.message}`);
    }
  }

  function generateAndBroadcastNMEA() {
    simStep++;
    
    let performanceUpdateTicks = (options.perfUpdateInterval || 5) * 10; 
    if (simStep % performanceUpdateTicks === 1 || simStep === 1) {
      let minPerf = (options.minPerformance || 92) / 100;
      let maxPerf = (options.maxPerformance || 98) / 100;
      randomVarianceScalar = minPerf + (Math.random() * (maxPerf - minPerf));
      resolveActivePolarTarget(14.0); 
    }

    let isGybeMode = options.maneuverMode === 'gybe';
    
    let activeTargetAngle = orcTargetAngle;
    let activeTargetSTW = orcTargetSTW;
    
    if (isGybeMode && orcTargetAngle < 90) {
      activeTargetAngle = 152.0; 
      activeTargetSTW = 8.71;
    } else if (!isGybeMode && orcTargetAngle > 90) {
      activeTargetAngle = 37.8;  
      activeTargetSTW = 5.85;
    }

    let baseSTWKnots = activeTargetSTW * randomVarianceScalar;
    let baseAWSKnots = 14.0; 

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
    }

    let vhw = `IIVHW,,T,,M,${currentSTWKnots.toFixed(2)},N,,K`;
    let vhwSentence = appendChecksum(vhw);

    let awaFormatted = currentAWADeg < 0 ? 360 + currentAWADeg : currentAWADeg;
    let mwv = `IIMWV,${awaFormatted.toFixed(1)},R,${baseAWSKnots.toFixed(1)},N,A`;
    let mwvSentence = appendChecksum(mwv);

    let rudderStr = currentRudderDeg.toFixed(1);
    let rsa = `IIRSA,${rudderStr},A,,`;
    let rsaSentence = appendChecksum(rsa);

    const payload = `${vhwSentence}\r\n${mwvSentence}\r\n${rsaSentence}\r\n`;
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
        description: 'Updates automatically when the database sync completes.',
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