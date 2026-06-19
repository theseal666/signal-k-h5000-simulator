const fs = require('fs');
const path = require('path');

module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;
  let options = {};

  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator & Wind Deriver';
  plugin.description = 'Derives vectors from raw inputs or injects high-frequency test sequences adjusted by official ORC targets and performance efficiency ranges.';

  let currentSTW = 0;   // m/s
  let currentRudder = 0;// rad
  let currentAWA = 0;   // rad
  let currentAWS = 0;   // m/s
  
  let simStep = 0;
  let orcTargetSTW = 7.80; // Knots fallback baseline

  plugin.start = function (startOptions) {
    options = startOptions || {};

    // 1. If an ORC link is specified, fetch the certificate data matrix profile asynchronously
    if (options.orcUrl) {
      fetchOrcPolarTargets(options.orcUrl);
    } else {
      orcTargetSTW = options.simTargetStw || 7.80;
    }

    // 2. Bind active network listeners
    let localSub = {
      context: 'vessels.self',
      subscribe: [
        { path: 'navigation.speedThroughWater', period: 100 },
        { path: 'steering.rudderAngle', period: 100 },
        { path: 'environment.wind.angleApparent', period: 100 },
        { path: 'environment.wind.speedApparent', period: 100 },
        { path: 'environment.wind.speedTrue', period: 500 }
      ]
    };

    app.subscriptionmanager.subscribe(
      localSub,
      unsubscribes,
      subscriptionError => {
        app.error('H5000 Raw Instrument data binding error: ' + subscriptionError);
      },
      delta => {
        if (options.enableSimulation) return; // Drop physical packets if mock simulator is hot

        delta.updates.forEach(update => {
          update.values.forEach(kv => {
            if (kv.path === 'navigation.speedThroughWater') currentSTW = kv.value;
            if (kv.path === 'steering.rudderAngle') currentRudder = kv.value;
            if (kv.path === 'environment.wind.angleApparent') currentAWA = kv.value;
            if (kv.path === 'environment.wind.speedApparent') currentAWS = kv.value;
            if (kv.path === 'environment.wind.speedTrue') {
              resolveLivePolarTargets(kv.value);
            }
          });
        });

        deriveAndEmitWindVectors();
      }
    );

    // 3. Kick off execution loop
    simInterval = setInterval(() => {
      if (options.enableSimulation) {
        generateSimulationData();
        deriveAndEmitWindVectors();
      }
    }, 100);
  };

  async function fetchOrcPolarTargets(url) {
    try {
      app.debug(`Simulator querying ORC data curve profile: ${url}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      
      if (data && data.rms) {
        options.polarData = data.rms;
        resolveLivePolarTargets(6.17); // Check default 12kn wind profile initially
      }
    } catch (err) {
      app.error('Simulator ORC lookup failed, using fallback metrics: ' + err.message);
      orcTargetSTW = options.simTargetStw || 7.80;
    }
  }

  function resolveLivePolarTargets(twsMS) {
    if (!options.polarData) return;
    let twsKnots = twsMS * 1.94384;
    
    try {
      let vpp = options.polarData;
      // Isolate targets depending on if the checkbox flags tracking upwind (tacks) or downwind (gybes)
      let targetArray = options.maneuverMode === 'gybe' ? vpp.vmgDownwind : vpp.vmgUpwind;
      
      if (targetArray && Array.isArray(targetArray)) {
        let target = targetArray.find(item => twsKnots <= item.tws);
        if (target) {
          orcTargetSTW = target.vboat || options.simTargetStw || 7.80;
        }
      }
    } catch (e) {
      app.error('Simulator error sorting ORC polar matrix: ' + e.message);
    }
  }

  function deriveAndEmitWindVectors() {
    let awaCos = Math.cos(currentAWA);
    let awaSin = Math.sin(currentAWA);

    let apparentX = currentAWS * awaCos;
    let apparentY = currentAWS * awaSin;

    let trueX = apparentX - currentSTW;
    let trueY = apparentY; 

    let derivedTWS = Math.sqrt(trueX * trueX + trueY * trueY);
    let derivedTWA = Math.atan2(trueY, trueX);
    let derivedVMG = currentSTW * Math.cos(derivedTWA);

    let values = [
      { path: 'navigation.speedThroughWater', value: Number(currentSTW.toFixed(4)) },
      { path: 'steering.rudderAngle', value: Number(currentRudder.toFixed(4)) },
      { path: 'environment.wind.angleApparent', value: Number(currentAWA.toFixed(4)) },
      { path: 'environment.wind.speedApparent', value: Number(currentAWS.toFixed(4)) },
      { path: 'environment.wind.angleTrueWater', value: Number(derivedTWA.toFixed(4)) },
      { path: 'environment.wind.speedTrue', value: Number(derivedTWS.toFixed(4)) },
      { path: 'navigation.velocityMadeGood', value: Number(derivedVMG.toFixed(4)) }
    ];

    app.handleMessage(plugin.id, { updates: [{ values: values }] });
  }

  function generateSimulationData() {
    simStep++;
    
    // Calculate dynamic performance modifier ranges (e.g., between 92% and 98%)
    let minPerf = (options.minPerformance || 92) / 100;
    let maxPerf = (options.maxPerformance || 98) / 100;
    
    // Create an fluctuating scalar profile inside that execution slice window
    let randomVarianceScalar = minPerf + (Math.random() * (maxPerf - minPerf));

    let baseSTW = (orcTargetSTW / 1.94384) * randomVarianceScalar; 
    let baseAWS = 14.0 / 1.94384; 

    // Set target base angles dynamically based on Tack vs Gybe configurations
    let isGybeMode = options.maneuverMode === 'gybe';
    let entryAwaDeg = isGybeMode ? -145 : -28; 
    let deadZoneAwaDeg = isGybeMode ? 180 : 0;  // Gybes cross through running downwind deadzones

    // Factor performance range scaling directly into target Apparent Wind Angle variance 
    let entryAwaRad = (entryAwaDeg * (1 / randomVarianceScalar)) * Math.PI / 180;

    let loopStep = simStep % 400; 

    if (loopStep >= 50 && loopStep < 70) {
      // Phase 1: Helmet deflection into turn sequence
      let progress = (loopStep - 50) / 20;
      currentRudder = (isGybeMode ? -10 : 8) * Math.PI / 180 * progress;
      currentAWA = entryAwaRad + (((deadZoneAwaDeg * Math.PI / 180) - entryAwaRad) * 0.5 * progress);
      currentSTW = baseSTW - (0.4 * progress);
      currentAWS = baseAWS;
    } 
    else if (loopStep >= 70 && loopStep < 115) {
      // Phase 2: Crossing the eye of wind line / passing the run deadzone axis
      let progress = (loopStep - 70) / 45;
      currentRudder = (isGybeMode ? -14 : 12) * Math.PI / 180;
      
      let currentTargetAwa = (deadZoneAwaDeg + (isGybeMode ? -40 : 45) * progress) * Math.PI / 180;
      currentAWA = currentTargetAwa * randomVarianceScalar; 
      
      let speedDropFactor = 1.0 - (0.48 * Math.sin(progress * Math.PI / 2));
      currentSTW = baseSTW * speedDropFactor;
      currentAWS = baseAWS - 1.5;
    } 
    else if (loopStep >= 115 && loopStep < 320) {
      // Phase 3: Acceleration build recovery window
      let progress = (loopStep - 115) / 205;
      currentRudder = (isGybeMode ? 2 : -2) * Math.PI / 180; 
      
      let exitTargetAwa = (isGybeMode ? 145 : 28) * Math.PI / 180;
      currentAWA = exitTargetAwa * (1 / randomVarianceScalar);
      
      let accelerationFactor = 0.52 + (0.48 * Math.sqrt(progress));
      currentSTW = baseSTW * accelerationFactor;
      currentAWS = baseAWS;
    } 
    else {
      // Phase 4: Steady-State Baseline Sailing Line
      currentRudder = 0.0;
      currentAWA = entryAwaRad; 
      currentSTW = baseSTW;
      currentAWS = baseAWS;
    }
  }

  plugin.stop = function () {
    if (simInterval) clearInterval(simInterval);
    unsubscribes.forEach(f => f());
    unsubscribes = [];
  };

  plugin.schema = {
    type: 'object',
    title: 'H5000 Dynamic Simulator Calibration Controls',
    properties: {
      enableSimulation: { type: 'boolean', title: 'Enable Virtual Tacking Simulator (Overrides network lines)', default: false },
      maneuverMode: { 
        type: 'string', 
        title: 'Maneuver Simulation Track Target', 
        default: 'tack',
        enum: ['tack', 'gybe'],
        enumNames: ['Tacking (Upwind Testing Sequence)', 'Gybing (Downwind Testing Sequence)']
      },
      orcUrl: { type: 'string', title: 'ORC Certificate API JSON URL (Resolves target polars continuously)' },
      simTargetStw: { type: 'number', title: 'Backup Simulation Base Speed (Knots - used if ORC is empty)', default: 7.80 },
      minPerformance: { type: 'number', title: 'Minimum Target Performance Filter Range (%)', default: 92 },
      maxPerformance: { type: 'number', title: 'Maximum Target Performance Filter Range (%)', default: 98 }
    }
  };

  return plugin;
};