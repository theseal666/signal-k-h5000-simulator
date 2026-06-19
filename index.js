const dgram = require('dgram');

module.exports = function (app) {
  const plugin = {};
  let simInterval = null;
  let options = {};
  const udpClient = dgram.createSocket('udp4');

  // Hardcoded identity specifications to guarantee listing registration
  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator';
  plugin.description = 'Generates high-frequency custom performance polar matrices and transmits sentences over NMEA 0183 / UDP.';

  let simStep = 0;
  let isCurrentlyStarboard = true;
  let currentTWSRegime = 14.0;
  const orcWindSpectrum = [4, 6, 8, 10, 12, 14, 16, 20, 24];
  
  let orcTargetSTW = 5.85;   
  let orcTargetAngle = 37.8; 
  let randomVarianceScalar = 0.95; 
  let filteredVMG = 0.0;
  const dampingFactor = 0.033;

  plugin.start = function (startOptions) {
    options = startOptions || {};
    isCurrentlyStarboard = true;

    // Run the high frequency generation loop if enabled
    if (options.enableSimulation !== false) {
      simInterval = setInterval(() => {
        generateAndBroadcastNMEA();
      }, 100);
    }
  };

  function generateAndBroadcastNMEA() {
    simStep++;
    
    // Fallback checks read your exact field name configurations safely
    let stepInterval = (options.perfUpdateInterval || 300) * 10; 
    if (simStep % stepInterval === 1 || simStep === 1) {
      let currentIdx = orcWindSpectrum.indexOf(currentTWSRegime);
      let nextIdx = (currentIdx + 1) % orcWindSpectrum.length;
      currentTWSRegime = orcWindSpectrum[nextIdx];

      let minPerf = (options.minPerformance || 92) / 100;
      let maxPerf = (options.maxPerformance || 98) / 100;
      randomVarianceScalar = minPerf + (Math.random() * (maxPerf - minPerf));
    }

    let baseSTWKnots = orcTargetSTW * randomVarianceScalar;
    let totalLoopTicks = 450;
    let loopStep = simStep % totalLoopTicks;

    if (loopStep === 0 && simStep > 1) {
      isCurrentlyStarboard = !isCurrentlyStarboard;
    }

    let side = isCurrentlyStarboard ? 1 : -1;
    let currentAWADeg = orcTargetAngle * side;
    let currentSTWKnots = baseSTWKnots;
    let currentRudderDeg = 0.0;

    let awaRad = (currentAWADeg * Math.PI) / 180;
    let awsKnots = currentTWSRegime; 
    
    let apparentX = awsKnots * Math.cos(awaRad) - currentSTWKnots;
    let apparentY = awsKnots * Math.sin(awaRad);
    let derivedTWADeg = Math.abs(Math.atan2(apparentY, apparentX) * 180 / Math.PI);

    let twaRad = (derivedTWADeg * Math.PI) / 180;
    let rawVMGKnots = Math.abs(currentSTWKnots * Math.cos(twaRad));
    
    filteredVMG = filteredVMG + dampingFactor * (rawVMGKnots - filteredVMG);

    // Stream live path updates to delta pipeline mechanics
    try {
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: [
              { path: 'environment.wind.speedTrue', value: currentTWSRegime / 1.94384 },
              { path: 'environment.wind.angleTrue', value: (derivedTWADeg * Math.PI) / 180 },
              { path: 'navigation.speedThroughWater', value: currentSTWKnots / 1.94384 },
              { path: 'performance.currentRatio', value: randomVarianceScalar }
            ]
          }
        ]
      });
    } catch (err) {}

    // Generate NMEA strings to feed your network dependencies
    let vhwSentence = appendChecksum(`IIVHW,,T,,M,${currentSTWKnots.toFixed(2)},N,,K`);
    let awaFormatted = currentAWADeg < 0 ? 360 + currentAWADeg : currentAWADeg;
    let mwvApparentSentence = appendChecksum(`IIMWV,${awaFormatted.toFixed(1)},R,${awsKnots.toFixed(1)},N,A`);
    let mwvTrueSentence = appendChecksum(`IIMWV,${derivedTWADeg.toFixed(1)},T,${currentTWSRegime.toFixed(1)},N,A`);
    let vmgSentence = appendChecksum(`IIVMG,${filteredVMG.toFixed(2)},N,,`);
    let rsaSentence = appendChecksum(`IIRSA,${currentRudderDeg.toFixed(1)},A,,`);

    const payload = `${vhwSentence}\r\n${mwvApparentSentence}\r\n${mwvTrueSentence}\r\n${vmgSentence}\r\n${rsaSentence}\r\n`;
    
    try {
      udpClient.send(payload, 2222, '127.0.0.1');
    } catch (err) {}
  }

  function appendChecksum(sentenceWithoutSign) {
    let checksum = 0;
    for (let i = 0; i < sentenceWithoutSign.length; i++) checksum ^= sentenceWithoutSign.charCodeAt(i);
    return `$${sentenceWithoutSign}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
  }

  plugin.stop = function () {
    if (simInterval) {
      clearInterval(simInterval);
      simInterval = null;
    }
  };

  // The properties keys must match your configuration UI screenshots identically
  plugin.schema = {
    type: 'object',
    title: 'H5000 Network UDP Simulator Controls',
    properties: {
      enableSimulation: { type: 'boolean', title: 'Enable Simulator Output Feed', default: true },
      perfUpdateInterval: { type: 'number', title: 'Performance Scalar Step Changes (Seconds)', default: 300 },
      orcYachtName: { type: 'string', title: 'ORC Yacht Name Lookup Field', default: 'Oxygen' },
      orcCountryId: { type: 'string', title: 'ORC Country Prefix Code', default: 'SWE' },
      lastVerifiedVessel: { type: 'string', title: 'Active Verified Vessel Status', default: 'Karukera (SWE 1220)' },
      lastVerifiedCert: { type: 'string', title: 'Live Verified Certificate #', default: '03200004T88' },
      minPerformance: { type: 'number', title: 'Minimum Target Performance Filter Range (%)', default: 92 },
      maxPerformance: { type: 'number', title: 'Maximum Target Performance Filter Range (%)', default: 98 }
    }
  };

  return plugin;
};