const dgram = require('dgram');

module.exports = function (app) {
  const plugin = {};
  let simInterval = null;
  let options = {};
  const udpClient = dgram.createSocket('udp4');

  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator (UDP Sentences)';
  plugin.description = 'Broadcasts high-frequency simulated NMEA 0183 sentences over UDP port 2222 with highly realistic tack/gybe speed drops and acceleration overshoots.';

  let simStep = 0;
  let orcTargetSTW = 7.80; // Knots baseline fallback
  let randomVarianceScalar = 0.95; // Performance scalar tracking state

  plugin.start = function (startOptions) {
    options = startOptions || {};

    if (options.orcCertId) {
      fetchOrcPolarMatrix(options.orcCertId);
    } else {
      orcTargetSTW = options.simTargetStw || 7.80;
    }

    if (options.enableSimulation) {
      simInterval = setInterval(() => {
        generateAndBroadcastNMEA();
      }, 100);
    }
  };

  async function fetchOrcPolarMatrix(certId) {
    const url = `https://data.orc.org/public/WPub.dll?cmd=viewjson&id=${certId.trim()}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      const data = await response.json();
      
      if (data && data.vpp) {
        options.polarData = data.vpp;
        resolveActivePolarTarget(14.0);
      } else if (data && data.rms) {
        options.polarData = data.rms;
        resolveActivePolarTarget(14.0);
      }
    } catch (err) {
      app.error(`Simulator ORC connection failed: ${err.message}`);
      orcTargetSTW = options.simTargetStw || 7.80;
    }
  }

  function resolveActivePolarTarget(twsKnots) {
    if (!options.polarData) return;
    try {
      const vpp = options.polarData;
      const targetArray = options.maneuverMode === 'gybe' ? vpp.vmgDownwind : vpp.vmgUpwind;
      
      if (targetArray && Array.isArray(targetArray)) {
        let match = targetArray.find(item => twsKnots <= item.tws);
        if (!match) match = targetArray[targetArray.length - 1]; 
        
        if (match && match.vboat) {
          orcTargetSTW = match.vboat;
        }
      }
    } catch (e) {
      app.error(`Simulator error sorting ORC object: ${e.message}`);
    }
  }

  function generateAndBroadcastNMEA() {
    simStep++;
    
    // Performance update frequency scalar update step
    let performanceUpdateTicks = (options.perfUpdateInterval || 5) * 10; 
    if (simStep % performanceUpdateTicks === 1 || simStep === 1) {
      let minPerf = (options.minPerformance || 92) / 100;
      let maxPerf = (options.maxPerformance || 98) / 100;
      randomVarianceScalar = minPerf + (Math.random() * (maxPerf - minPerf));
    }

    // Set targets based on selected mode
    let isGybeMode = options.maneuverMode === 'gybe';
    let baseSTWKnots = orcTargetSTW * randomVarianceScalar;
    let baseAWSKnots = 14.0; 

    // Target angles (Starboard vs Port boards)
    let entryAwa = isGybeMode ? 145 : 32;  // Initial board (e.g., Starboard)
    let exitAwa = isGybeMode ? -145 : -32; // New board (e.g., Port)
    let dynamicOvershootAwa = isGybeMode ? -135 : -42; // Footing angle to rebuild speed (wider)

    let totalLoopTicks = (options.maneuverInterval || 45) * 10;
    let loopStep = simStep % totalLoopTicks;

    let currentSTWKnots = baseSTWKnots;
    let currentAWADeg = entryAwa;
    let currentRudderDeg = 0.0;

    // --- Dynamic Sailing Physics State Machine ---
    
    // Phase 1: Heading up into the wind / Turning down into the run (0.0s -> 3.0s)
    if (loopStep >= 0 && loopStep < 30) {
      let progress = loopStep / 30;
      currentRudderDeg = (isGybeMode ? -8 : 6) * progress; // Smooth rudder deflection
      
      // Gradually steer toward the eye of the wind (0) or dead-downwind (180)
      let midWayAngle = isGybeMode ? 180 : 0;
      currentAWADeg = entryAwa + ((midWayAngle - entryAwa) * progress);
      
      // Speed begins to bleed out progressively due to turning resistance and canvas drag
      currentSTWKnots = baseSTWKnots - ((baseSTWKnots * 0.15) * progress);
    }
    // Phase 2: Passing through the critical zone & coming out on the new board (3.0s -> 7.0s)
    else if (loopStep >= 30 && loopStep < 70) {
      let progress = (loopStep - 30) / 40;
      currentRudderDeg = (isGybeMode ? -12 : 10); // Maintain strong helm deflection
      
      // Sweep through the center axis out to the footing overshoot angle on the new boards
      let midWayAngle = isGybeMode ? 180 : 0;
      currentAWADeg = midWayAngle + ((dynamicOvershootAwa - midWayAngle) * progress);
      
      // Speed plummets to its lowest point right as the boat tries to clear the corner
      let maxSpeedDrop = baseSTWKnots * (isGybeMode ? 0.25 : 0.45); // Upwind loses more speed than downwind
      currentSTWKnots = (baseSTWKnots * 0.85) - (maxSpeedDrop * Math.sin(progress * Math.PI / 2));
    }
    // Phase 3: The Overshoot / Footing to rebuild acceleration hole (7.0s -> 17.0s)
    else if (loopStep >= 70 && loopStep < 170) {
      let progress = (loopStep - 70) / 100;
      currentRudderDeg = (isGybeMode ? 3 : -2) * (1 - progress); // Counter-steer to catch the boat, then center
      
      // Hold the wide footing angle initially, then slowly heat it up toward target polar lines
      currentAWADeg = dynamicOvershootAwa + ((exitAwa - dynamicOvershootAwa) * Math.pow(progress, 2));
      
      // Speed recovers from the bottom of the trench and accelerates back up
      let lowestSpeed = baseSTWKnots * (isGybeMode ? 0.60 : 0.40);
      currentSTWKnots = lowestSpeed + ((baseSTWKnots - lowestSpeed) * Math.sqrt(progress));
    }
    // Phase 4: Settled and tracking optimally on the new boards (17.0s -> End)
    else {
      currentRudderDeg = 0.0;
      currentAWADeg = exitAwa;
      currentSTWKnots = baseSTWKnots;
    }

    // --- Compile Output NMEA Sentences ---
    let vhw = `IIVHW,,T,,M,${currentSTWKnots.toFixed(2)},N,,K`;
    let vhwSentence = appendChecksum(vhw);

    // Keep angles formatted properly in positive 0-360 range for legacy instrument ears
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
      orcCertId: { type: 'string', title: 'ORC Certificate Ref ID String', default: '03200002P4H' },
      simTargetStw: { type: 'number', title: 'Baseline Backup Speed (Knots)', default: 7.80 },
      minPerformance: { type: 'number', title: 'Minimum Target Performance Filter Range (%)', default: 92 },
      maxPerformance: { type: 'number', title: 'Maximum Target Performance Filter Range (%)', default: 98 }
    }
  };

  return plugin;
};