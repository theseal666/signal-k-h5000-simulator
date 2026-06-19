module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;
  let options = {};

  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator & Wind Deriver';
  plugin.description = 'Derives complex vectors (TWA, TWS, VMG) from raw instrument configurations or injects a high-frequency test array.';

  let currentSTW = 0;   // m/s
  let currentRudder = 0;// rad
  let currentAWA = 0;   // rad
  let currentAWS = 0;   // m/s
  
  let simStep = 0;

  plugin.start = function (startOptions) {
    options = startOptions || {};

    // Subscribe to basic core instrument paths coming off the network
    let localSub = {
      context: 'vessels.self',
      subscribe: [
        { path: 'navigation.speedThroughWater', period: 100 },
        { path: 'steering.rudderAngle', period: 100 },
        { path: 'environment.wind.angleApparent', period: 100 },
        { path: 'environment.wind.speedApparent', period: 100 }
      ]
    };

    app.subscriptionmanager.subscribe(
      localSub,
      unsubscribes,
      subscriptionError => {
        app.error('H5000 Raw Instrument data binding error: ' + subscriptionError);
      },
      delta => {
        // If we are actively simulating, drop live network values on the floor
        if (options.enableSimulation) return;

        delta.updates.forEach(update => {
          update.values.forEach(kv => {
            if (kv.path === 'navigation.speedThroughWater') currentSTW = kv.value;
            if (kv.path === 'steering.rudderAngle') currentRudder = kv.value;
            if (kv.path === 'environment.wind.angleApparent') currentAWA = kv.value;
            if (kv.path === 'environment.wind.speedApparent') currentAWS = kv.value;
          });
        });

        deriveAndEmitWindVectors();
      }
    );

    // Setup the high-frequency clock execution loop
    simInterval = setInterval(() => {
      if (options.enableSimulation) {
        generateSimulationData();
        deriveAndEmitWindVectors();
      }
    }, 100);
  };

  function deriveAndEmitWindVectors() {
    // Vector calculation variables (SI units: meters/sec & radians)
    let awaCos = Math.cos(currentAWA);
    let awaSin = Math.sin(currentAWA);

    let apparentX = currentAWS * awaCos;
    let apparentY = currentAWS * awaSin;

    // Subtract the boat speed forward vector out of the apparent wind grid
    let trueX = apparentX - currentSTW;
    let trueY = apparentY; 

    let derivedTWS = Math.sqrt(trueX * trueX + trueY * trueY);
    let derivedTWA = Math.atan2(trueY, trueX);
    
    // Upwind VMG calculation
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
    let targetSTWKnots = options.simTargetStw || 7.8;
    let baseSTW = targetSTWKnots / 1.94384; 
    let baseAWS = 14.0 / 1.94384; 

    // Every 30 seconds (300 steps at 100ms) runs a test maneuver cycle
    let loopStep = simStep % 300; 

    if (loopStep >= 50 && loopStep < 65) {
      let progress = (loopStep - 50) / 15;
      currentRudder = (8 * Math.PI / 180) * progress;
      currentAWA = (-28 + (40 * progress)) * Math.PI / 180;
      currentSTW = baseSTW - (0.5 * progress);
      currentAWS = baseAWS;
    } 
    else if (loopStep >= 65 && loopStep < 100) {
      let progress = (loopStep - 65) / 35;
      currentRudder = 12 * Math.PI / 180;
      currentAWA = (12 + (44 * progress)) * Math.PI / 180;
      
      let speedDropFactor = 1.0 - (0.45 * Math.sin(progress * Math.PI / 2));
      currentSTW = baseSTW * speedDropFactor;
      currentAWS = baseAWS - 1.2;
    } 
    else if (loopStep >= 100 && loopStep < 250) {
      let progress = (loopStep - 100) / 150;
      currentRudder = -2 * Math.PI / 180; 
      currentAWA = (56 - (28 * Math.min(1, progress * 2))) * Math.PI / 180;
      
      let accelerationFactor = 0.55 + (0.45 * Math.sqrt(progress));
      currentSTW = baseSTW * accelerationFactor;
      currentAWS = baseAWS;
    } 
    else {
      currentRudder = 0.0;
      currentAWA = -28 * Math.PI / 180; 
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
    title: 'H5000 Simulator Config',
    properties: {
      enableSimulation: { type: 'boolean', title: 'Enable Virtual Tacking Simulator (Overrides network lines)', default: false },
      simTargetStw: { type: 'number', title: 'Simulation Base Speed (Knots)', default: 7.80 }
    }
  };

  return plugin;
};