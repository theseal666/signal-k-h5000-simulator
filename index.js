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
  
  // Runtime internal targets (dynamically overwritten on successful API fetch)
  let orcTargetSTW = 7.80;   
  let orcTargetAngle = 32.0; 
  let randomVarianceScalar = 0.95; 

  plugin.start = function (startOptions) {
    options = startOptions || {};

    // 1. Fire off the live network API fetch using the configuration input reference
    if (options.orcCertRef) {
      fetchOrcPolarMatrix(options.orcCertRef);
    }

    // 2. Start the 10Hz network simulation clock loop
    if (options.enableSimulation) {
      simInterval = setInterval(() => {
        generateAndBroadcastNMEA();
      }, 100);
    }
  };

  async function fetchOrcPolarMatrix(inputString) {
    // Robust extraction: Pulls just the alphanumeric reference ID from either a pasted URL or raw string entry
    const matchMatch = inputString.trim().match(/(?:CC\/)?([A-Za-z0-9]+)$/);
    const certId = matchMatch ? matchMatch[1] : null;

    if (!certId) {
      app.error(`Simulator could not isolate a valid ORC reference key from input: "${inputString}"`);
      return;
    }

    // Constructed using official ORC documentation rules for individual boat JSON record streaming
    const url = `https://data.orc.org/public/WPub.dll?action=DownBoatRMS&RefNo=${certId}&ext=json`;
    
    try {
      app.debug(`Simulator querying live official ORC endpoint: ${url}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6-second connection drop wall
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) throw new Error(`ORC gateway returned status code: ${response.status}`);
      
      const data = await response.json();
      
      // Navigate through the official query result structure: a single-boat wrapper array named 'rms'
      if (data && Array.isArray(data.rms) && data.rms.length > 0) {
        const activeBoatRecord = data.rms[0];
        
        if (activeBoatRecord.vpp) {
          options.polarData = activeBoatRecord.vpp;
          app.debug(`[ORC Engine Init] Successfully bound VPP polar matrices for boat reference: ${certId}`);
          
          // Prime the simulation targeting data immediately for a 14-knot baseline breeze
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
      
      // Select the correct performance array table based on current dashboard setting
      const targetArray = isGybeMode ? vpp.vmgDownwind : vpp.vmgUpwind;
      
      if (targetArray && Array.isArray(targetArray)) {
        // Step through wind steps (6, 8, 10, 12, 14...) to find the matching entry block
        let match = targetArray.find(item => twsKnots <= item.tws);
        if (!match) match = targetArray[targetArray.length - 1]; // Fallback threshold boundary protection
        
        if (match) {
          orcTargetSTW = match.vboat || orcTargetSTW;
          
          // Upwind profiles utilize 'upwindAngle' key; downwind profiles look for 'downwindAngle'
          orcTargetAngle = isGybeMode ? (match.downwindAngle || 152.0) : (match.upwindAngle || 37.8);
          
          app.debug(`[ORC Polar Update] Live Targets -> STW: ${orcTargetSTW.toFixed(2)} kn | Wind Angle: ${orcTargetAngle.toFixed(1)}°`);
        }
      }
    } catch (e) {
      app.error(`Error processing live VPP target properties array: ${e.message}`);
    }
  }

  function generateAndBroadcastNMEA() {
    simStep++;
    
    // Performance update frequency scalar update step execution block
    let performanceUpdateTicks = (options.perfUpdateInterval || 5) * 10; 
    if (simStep % performanceUpdateTicks === 1 || simStep === 1) {
      let minPerf = (options.minPerformance || 92) / 100;
      let maxPerf = (options.maxPerformance || 98) / 100;
      randomVarianceScalar = minPerf + (Math.random() * (maxPerf - minPerf));
      
      // Keep tracking calculations tightly aligned against active menu modes
      resolveActivePolarTarget(14.0); 
    }

    let isGybeMode = options.maneuverMode === 'gybe';
    
    // Targets derived straight out of your live certificate data parsing layer
    let baseSTWKnots = orcTargetSTW * randomVarianceScalar;
    let baseAWSKnots = 14.0; 

    // Dynamically mapped angles tracking directly to your certificate data targets
    let entryAwa = orcTargetAngle;  
    let exitAwa = -orcTargetAngle; 
    let dynamicOvershootAwa = isGybeMode ? -(orcTargetAngle - 10) : -(orcTargetAngle + 10); 

    let totalLoopTicks = (options.maneuverInterval || 45) * 10;
    let loopStep = simStep % totalLoopTicks;

    let currentSTWKnots = baseSTWKnots;
    let currentAWADeg = entryAwa;
    let currentRudderDeg = 0.0;

    // --- Dynamic Sailing Physics Engine Execution Loop ---
    
    // Phase 1: Entry sweeping into turn sequence (0.0s -> 3.0s)
    if (loopStep >= 0 && loopStep < 30) {
      let progress = loopStep / 30;
      currentRudderDeg = (isGybeMode ? -8 : 6) * progress;
      
      let midWayAngle = isGybeMode ? 180 : 0;
      currentAWADeg = entryAwa + ((midWayAngle - entryAwa) * progress);
      currentSTWKnots = baseSTWKnots - ((baseSTWKnots * 0.15) * progress);
    }
    // Phase 2: Crossing the eye / passing the run axis out to wide target (3.0s -> 7.0s)
    else if (loopStep >= 30 && loopStep < 70) {
      let progress = (loopStep - 30) / 40;
      currentRudderDeg = (isGybeMode ? -12 : 10);
      
      let midWayAngle = isGybeMode ? 180 : 0;
      currentAWADeg = midWayAngle + ((dynamicOvershootAwa - midWayAngle) * progress);
      
      let maxSpeedDrop = baseSTWKnots * (isGybeMode ? 0.25 : 0.45);
      currentSTWKnots = (baseSTWKnots * 0.85) - (maxSpeedDrop * Math.sin(progress * Math.PI / 2));
    }
    // Phase 3: The Footing Phase — Accelerated overshoot to rebuild foil pressure (7.0s -> 17.0s)
    else if (loopStep >= 70 && loopStep < 170) {
      let progress = (loopStep - 70) / 100;
      currentRudderDeg = (isGybeMode ? 3 : -2) * (1 - progress); 
      
      currentAWADeg = dynamicOvershootAwa + ((exitAwa - dynamicOvershootAwa) * Math.pow(progress, 2));
      
      let lowestSpeed = baseSTWKnots * (isGybeMode ? 0.60 : 0.40);
      currentSTWKnots = lowestSpeed + ((baseSTWKnots - lowestSpeed) * Math.sqrt(progress));
    }
    // Phase 4: Optimal steady-state tracking on opposite boards (17.0s -> End)
    else {
      currentRudderDeg = 0.0;
      currentAWADeg = exitAwa;
      currentSTWKnots = baseSTWKnots;
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