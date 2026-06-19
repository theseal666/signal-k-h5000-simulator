const dgram = require('dgram');

module.exports = function (app) {
  const plugin = {};
  let simInterval = null;
  let options = {};
  const udpClient = dgram.createSocket('udp4');

  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator (UDP Sentences)';
  plugin.description = 'Broadcasts high-frequency simulated NMEA 0183 sentences over UDP port 2222 to mimic real hardware data connections.';

  let simStep = 0;

  plugin.start = function (startOptions) {
    options = startOptions || {};
    if (!options.enableSimulation) return;

    // 10Hz Physics Loop
    simInterval = setInterval(() => {
      generateAndBroadcastNMEA();
    }, 100);
  };

  function generateAndBroadcastNMEA() {
    simStep++;
    
    let minPerf = (options.minPerformance || 92) / 100;
    let maxPerf = (options.maxPerformance || 98) / 100;
    let randomVarianceScalar = minPerf + (Math.random() * (maxPerf - minPerf));

    let targetSTWKnots = (options.simTargetStw || 7.8) * randomVarianceScalar;
    let baseAWSKnots = 14.0; 

    let isGybeMode = options.maneuverMode === 'gybe';
    let entryAwaDeg = isGybeMode ? 145 : 32; 
    let deadZoneAwaDeg = isGybeMode ? 180 : 0;  

    let loopStep = simStep % 400;
    let currentSTWKnots = targetSTWKnots;
    let currentAWADeg = entryAwaDeg;
    let currentRudderDeg = 0;

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
      currentRudderDeg = (isGybeMode ? 2 : -2); 
      let exitTargetAwa = isGybeMode ? 145 : 32;
      currentAWADeg = exitTargetAwa;
      let accelerationFactor = 0.55 + (0.45 * Math.sqrt(progress));
      currentSTWKnots = targetSTWKnots * accelerationFactor;
    }

    // --- Format into standard NMEA 0183 Sentences ---
    // $IIVHW: Water Speed and Heading (Using 000 for mock heading)
    let vhw = `IIVHW,,T,,M,${currentSTWKnots.toFixed(2)},N,,K`;
    let vhwSentence = appendChecksum(vhw);

    // $IIMWV: Wind Speed and Angle (R = Relative / Apparent)
    // Keep angle positive for NMEA standard formatting
    let awaFormatted = currentAWADeg < 0 ? 360 + currentAWADeg : currentAWADeg;
    let mwv = `IIMWV,${awaFormatted.toFixed(1)},R,${baseAWSKnots.toFixed(1)},N,A`;
    let mwvSentence = appendChecksum(mwv);

    // Blast payload over local UDP transmission link
    const payload = `${vhwSentence}\r\n${mwvSentence}\r\n`;
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
      maneuverMode: { type: 'string', title: 'Mode', default: 'tack', enum: ['tack', 'gybe'] },
      simTargetStw: { type: 'number', title: 'Baseline Speed (Knots)', default: 7.80 },
      minPerformance: { type: 'number', title: 'Min Performance (%)', default: 92 },
      maxPerformance: { type: 'number', title: 'Max Performance (%)', default: 98 }
    }
  };

  return plugin;
};