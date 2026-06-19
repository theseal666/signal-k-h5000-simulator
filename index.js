const dgram = require('dgram');

module.exports = function (app) {
  const plugin = {};
  let simInterval = null;
  let options = {};
  const udpClient = dgram.createSocket('udp4');

  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator (UDP Sentences)';
  plugin.description = 'Broadcasts high-frequency simulated NMEA 0183 sentences over UDP port 2222 with configurable maneuver intervals, dynamic rudder updates, and stepped performance tracking.';

  let simStep = 0;
  let orcTargetSTW = 7.80; // Knots baseline fallback
  let randomVarianceScalar = 0.95; // Initial performance scalar match

  plugin.start = function (startOptions) {
    options = startOptions || {};

    // 1. Asynchronously load the ORC profile if a certificate ID is present
    if (options.orcCertId) {
      fetchOrcPolarMatrix(options.orcCertId);
    } else {
      orcTargetSTW = options.simTargetStw || 7.80;
    }

    // 2. Start the 10Hz network generation loop
    if (options.enableSimulation) {
      simInterval = setInterval(() => {
        generateAndBroadcastNMEA();
      }, 100);
    }
  };

  async function fetchOrcPolarMatrix(certId) {
    const url = `https://data.orc.org/public/WPub.dll?cmd=viewjson&id=${certId.trim()}`;
    try {
      app.debug(`Simulator querying ORC data payload line: ${url}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      const data = await response.json();
      
      if (data && data.vpp) {
        options.polarData = data.vpp;
        resolveActivePolarTarget(14.0); // Target standard 14kn simulated wind velocity profile
      } else if (data && data.rms) {
        options.polarData = data.rms;
        resolveActivePolarTarget(14.0);
      }
    } catch (err) {
      app.error(`Simulator ORC connection failed, using local backup metrics: ${err.message}`);
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
          app.debug(`Simulator adjusted baseline target speed directly from ORC: ${orcTargetSTW} Knots`);
        }
      }
    } catch (e) {
      app.error(`Simulator encountered structural error sorting ORC object: ${e.message}`);
    }
  }

  function generateAndBroadcastNMEA() {
    simStep++;
    
    // --- Performance Update Frequency Logic ---
    // Change the performance scalar variation step interval based on configuration (ticks are 100ms each)
    let performanceUpdateTicks = (options.perfUpdateInterval || 5) * 10; 
    if (simStep % performanceUpdateTicks === 1 || simStep === 1) {
      let minPerf = (options.minPerformance || 92) / 100;
      let maxPerf = (options.maxPerformance || 98) / 100;
      randomVarianceScalar = minPerf + (Math.random() * (maxPerf - minPerf));
    }

    // Dynamic target velocity tracking based directly on ORC values
    let targetSTWKnots = orcTargetSTW * randomVarianceScalar;
    let baseAWSKnots = 14.0; 

    let isGybeMode = options.maneuverMode === 'gybe';
    let entryAwaDeg = isGybeMode ? 145 : 32; 
    let deadZoneAwaDeg = isGybeMode ? 180 : 0;  

    // --- Maneuver Interval Logic ---
    // Convert maneuver configuration seconds directly to 10Hz array loop size
    let totalLoopTicks = (options.maneuverInterval || 45) * 10;
    let loopStep = simStep % totalLoopTicks;

    let currentSTWKnots = targetSTWKnots;
    let currentAWADeg = entryAwaDeg;
    let currentRudderDeg = 0.0;

    // Execute the maneuver window profile in the first 32 seconds of the loop
    if (loopStep >= 50 && loopStep < 70) {
      let progress = (loopStep - 50) / 20;
      currentRudderDeg = (isGybeMode ? -10 : 8) * progress;
      currentAWADeg = entryAwaDeg + ((deadZoneAwaDeg - entryAwaDeg) * 0.5 * progress);
      currentSTWKnots = targetSTWKnots - (1.5 * progress);
    } 
    else if (loopStep >= 70 && loopStep < 115) {
      let progress = (loopStep - 70) / 45;
      currentRudderDeg = (isGybeMode ? -14 : 12);
      currentAWADeg = deadZoneAwaDeg + ((isGybeMode ? -40 : 45) * progress);
      let speedDropFactor = 1.0 - (0.45 * Math.sin(progress * Math.PI / 2));
      currentSTWKnots = targetSTWKnots * speedDropFactor;
    } 
    else if (loopStep >= 115 && loopStep < 320) {
      let progress = (loopStep - 115) / 205;
      currentRudderDeg = (isGybeMode ? 2 : -2) * (1.0 - progress); // Return helm smoothly to center
      let exitTargetAwa = isGybeMode ? 145 : 32;
      currentAWADeg = exitTargetAwa;
      let accelerationFactor = 0.55 + (0.45 * Math.sqrt(progress));
      currentSTWKnots = targetSTWKnots * accelerationFactor;
    }
    else {
      // Steady sailing context baseline
      currentRudderDeg = 0.0;
      currentAWADeg = entryAwaDeg;
      currentSTWKnots = targetSTWKnots;
    }

    // --- Generate Output NMEA Sentences ---
    // $IIVHW: Speed Through Water
    let vhw = `IIVHW,,T,,M,${currentSTWKnots.toFixed(2)},N,,K`;
    let vhwSentence = appendChecksum(vhw);

    // $IIMWV: Apparent Wind Direction & Speed
    let awaFormatted = currentAWADeg < 0 ? 360 + currentAWADeg : currentAWADeg;
    let mwv = `IIMWV,${awaFormatted.toFixed(1)},R,${baseAWSKnots.toFixed(1)},N,A`;
    let mwvSentence = appendChecksum(mwv);

    // $IIRSA: Rudder Sensor Angle (Starboard/Port alignment tracking strings)
    // Format: $IIRSA,StbdAngle,A,PortAngle,A*Checksum
    let rudderStr = currentRudderDeg.toFixed(1);
    let rsa = `IIRSA,${rudderStr},A,,`;
    let rsaSentence = appendChecksum(rsa);

    // Send payload out over UDP link channel
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
      maneuverInterval: { type: 'number', title: 'How often to trigger a maneuver (Seconds)', default: 45 },
      perfUpdateInterval: { type: 'number', title: 'How often wind variance & performance changes (Seconds)', default: 5 },
      orcCertId: { type: 'string', title: 'ORC Certificate Ref ID String', default: '03200002P4H' },
      simTargetStw: { type: 'number', title: 'Baseline Backup Speed (Knots)', default: 7.80 },
      minPerformance: { type: 'number', title: 'Minimum Target Performance Filter Range (%)', default: 92 },
      maxPerformance: { type: 'number', title: 'Maximum Target Performance Filter Range (%)', default: 98 }
    }
  };

  return plugin;
};