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
  let isCurrentlyStarboard = true; // Tracks the starting tack state for the current interval loop

  // Base internal fallbacks (Overwritten upon successful API fetch)
  let orcTargetSTW = 7.80;   
  let orcTargetAngle = 32.0; 
  let randomVarianceScalar = 0.95; 

  plugin.start = function (startOptions) {
    options = startOptions || {};
    isCurrentlyStarboard = true; // Reset state on startup

    if (options.orcCertRef) {
      fetchOrcPolarMatrix(options.orcCertRef);
    }

    if (options.enableSimulation) {
      simInterval = setInterval(() => {
        generateAndBroadcastNMEA();
      }, 100);
    }
  };

  async function fetchOrcPolarMatrix(inputString) {
    const matchMatch = inputString.trim().toUpperCase().match(/(?:CC\/)?([A-Za-z0-9]+)$/);
    const certId = matchMatch ? matchMatch[1] : null;

    if (!certId) {
      app.error(`Simulator could not isolate a valid ORC reference key from input: "${inputString}"`);
      return;
    }

    const url = `https://data.orc.org/public/WPub.dll?action=DownBoatRMS&RefNo=${certId}&ext=json`;
    
    try {
      app.debug(`Simulator querying live official ORC endpoint: ${url}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) throw new Error(`ORC gateway returned status code: ${response.status}`);
      
      const data = await response.json();
      
      if (data && Array.isArray(data.rms) && data.rms.length > 0) {
        const activeBoatRecord = data.rms[0];
        
        if (activeBoatRecord.vpp) {
          options.polarData = activeBoatRecord.vpp;
          app.debug(`[ORC Engine Init] Successfully bound VPP polar matrices for boat reference: ${certId}`);
          resolveActivePolarTarget(14.0); 
        } else {
          app.error(`Matched record for ${certId}, but the object is missing its 'vpp' performance metrics block.`);
        }
      } else {
        app.error(`No active certification criteria matched on the database server for Reference Number: ${certId}`);
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
      const targetArray = isGybeMode ? vpp.vmgDownwind : vpp.vmgUpwind;
      
      if (targetArray && Array.isArray(targetArray)) {
        let match = targetArray.find(item => twsKnots <= item.tws);
        if (!match) match = targetArray[targetArray.length - 1];
        
        if (match) {
          if (isGybeMode) {
            orcTargetSTW = match.vboat || 7.50;
            orcTargetAngle = match.downwindAngle || 150.0;
          } else {
            orcTargetSTW = match.vboat || 5.85;
            orcTargetAngle = match.upwindAngle || 37.8;
          }
          app.debug(`[ORC Polar Update] Live Targets -> STW: ${orcTargetSTW.toFixed(2)} kn | Wind Angle: ${orcTargetAngle.toFixed(1)}°`);
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
    
    // Safety Fallback Guard
    let activeTargetAngle = orcTargetAngle;
    let activeTargetSTW = orcTargetSTW;
    
    if (isGybeMode && orcTargetAngle < 90) {
      activeTargetAngle = 150.0; 
      activeTargetSTW = 7.50;
    } else if (!isGybeMode && orcTargetAngle > 90) {
      activeTargetAngle = 37.8;  
      activeTargetSTW = 5.85;
    }

    let baseSTWKnots = activeTargetSTW * randomVarianceScalar;
    let baseAWSKnots = 14.0; 

    let totalLoopTicks = (options.maneuverInterval || 45) * 10;
    let loopStep = simStep % totalLoopTicks;

    // Flip-flop the tack orientation flag cleanly at the precise boundary reset tick
    if (loopStep === 0 && simStep > 1) {
      isCurrentlyStarboard = !isCurrentlyStarboard;
      app.debug(`[Simulation Clock Reset] Swapping active tracking orientation. New starting board: ${isCurrentlyStarboard ? 'Starboard' : 'Port'}`);
    }

    // Direction scalar modifier: 1 if maneuvering from STBD -> PORT, -1 if PORT -> STBD
    let side = isCurrentlyStarboard ? 1 : -1;

    let entryAwa = activeTargetAngle * side;  
    let exitAwa = -activeTargetAngle * side; 
    let dynamicOvershootAwa = isGybeMode ? -((activeTargetAngle - 10) * side) : -((activeTargetAngle + 10) * side); 

    let currentSTWKnots = baseSTWKnots;
    let currentAWADeg = entryAwa;
    let currentRudderDeg = 0.0;

    // --- Dynamic Sailing Physics Engine Execution Loop ---
    if (isGybeMode) {
      // DOWNWIND TWIN-AXIS CONTINUOUS GYBING LOOPS
      if (loopStep >= 0 && loopStep < 30) {
        let progress = loopStep / 30;
        currentRudderDeg = -5 * side * progress; 
        
        let targetBoundary = 180 * side; // Sweeping toward 180 or -180
        currentAWADeg = entryAwa + ((targetBoundary - entryAwa) * progress);
        currentSTWKnots = baseSTWKnots - ((baseSTWKnots * 0.10) * progress);
      }
      else if (loopStep >= 30 && loopStep < 70) {
        let progress = (loopStep - 30) / 40;
        currentRudderDeg = -12 * side; 
        
        let startAngle = 180 * side;
        let targetEndUnwrapped = dynamicOvershootAwa;
        
        // Correct the unwrap logic to support both directions crossing the 180 split line
        if (side === 1 && targetEndUnwrapped < 0) targetEndUnwrapped += 360;
        if (side === -1 && targetEndUnwrapped > 0) targetEndUnwrapped -= 360;
        
        let rawSweep = startAngle + ((targetEndUnwrapped - startAngle) * progress);
        
        // Normalize coordinates back safely inside -180 to 180 bounds
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
      // UPWIND TWIN-AXIS CONTINUOUS TACKING LOOPS
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

    // --- Format and Broadcast NMEA 0183 Output Sentences ---
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
      orcCertRef: { type: 'string', title: 'ORC Certificate ID Reference or URL Link', default: '03200002P4H' },
      minPerformance: { type: 'number', title: 'Minimum Target Performance Filter Range (%)', default: 92 },
      maxPerformance: { type: 'number', title: 'Maximum Target Performance Filter Range (%)', default: 98 }
    }
  };

  return plugin;
};