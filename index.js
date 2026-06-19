const dgram = require('dgram');
const https = require('https');

module.exports = function (app) {
  const plugin = {};
  let simInterval = null;
  let options = {};
  const udpClient = dgram.createSocket('udp4');

  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator (Dynamic ORC Registry)';
  plugin.description = 'Fetches real-time fleet polar matrices from the ORC registry based on your country code and populates an interactive boat selection list.';

  let simStep = 0;
  let isCurrentlyStarboard = true;
  let verifiedVesselName = 'None';
  let verifiedCertRef = 'None';

  let currentTWSRegime = 14.0;
  const orcWindSpectrum = [4, 6, 8, 10, 12, 14, 16, 20, 24];
  
  let orcTargetSTW = 5.85;   
  let orcTargetAngle = 37.8; 
  let randomVarianceScalar = 0.95; 

  let filteredVMG = 0.0;
  const dampingFactor = 0.033; // ~3-second damping window at 10Hz

  let cachedBoatsForSelectedCountry = [];

  plugin.start = function (startOptions) {
    if (simInterval) {
      clearInterval(simInterval);
      simInterval = null;
    }

    options = startOptions || {};
    isCurrentlyStarboard = true;

    // Load polar values for the chosen boat right away
    refreshActivePolarPayload();

    if (options.enableSimulation) {
      simInterval = setInterval(() => {
        generateAndBroadcastNMEA();
      }, 100);
    }
  };

  // Signal K lifecycle hook to populate the configuration schema dynamically
  plugin.configureSchema = async function () {
    const targetCountry = (options.orcCountryId || 'SWE').trim().toUpperCase();

    try {
      // Fetch all boats registered under the chosen country prefix
      const url = `https://data.orc.org/public/WPub.dll?action=DownRMS&CountryId=${targetCountry}&Family=ORC&ext=json`;
      app.debug(`Simulator downloading fleet registry for country: ${targetCountry}`);
      
      const rawJson = await makeHttpRequest(url);
      const data = JSON.parse(rawJson);
      const records = data && data.rms ? data.rms : [];
      
      cachedBoatsForSelectedCountry = records.map(boat => ({
        id: boat.RefNo || boat.YachtName,
        title: `${boat.YachtName || 'Unknown'} [${boat.SailNo || 'No Sail ID'}]`
      })).sort((a, b) => a.title.localeCompare(b.title));

    } catch (e) {
      app.debug(`Could not sync ORC fleet registry for ${targetCountry}: ${e.message}`);
    }

    // Map the fetched boats straight into the configuration dropdown schema
    if (cachedBoatsForSelectedCountry.length > 0) {
      plugin.schema.properties.orcSelectedVesselToken.enum = cachedBoatsForSelectedCountry.map(b => b.id);
      plugin.schema.properties.orcSelectedVesselToken.enumNames = cachedBoatsForSelectedCountry.map(b => b.title);
      plugin.schema.properties.orcSelectedVesselToken.description = `Successfully loaded ${cachedBoatsForSelectedCountry.length} active certificates for country group: ${targetCountry}`;
    } else {
      plugin.schema.properties.orcSelectedVesselToken.enum = ['None'];
      plugin.schema.properties.orcSelectedVesselToken.enumNames = [`No active certificates found for country "${targetCountry}"`];
      plugin.schema.properties.orcSelectedVesselToken.description = `Try clicking 'Save Configuration' after entering a valid 3-letter country code.`;
    }

    return plugin.schema;
  };

  function refreshActivePolarPayload() {
    if (!options.orcSelectedVesselToken || options.orcSelectedVesselToken === 'None') return;

    const url = `https://data.orc.org/public/WPub.dll?action=DownBoatRMS&RefNo=${encodeURIComponent(options.orcSelectedVesselToken)}&ext=json`;
    
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const records = data && data.rms ? data.rms : [];
          if (records.length > 0 && records[0].Allowances) {
            options.polarData = records[0].Allowances;
            verifiedVesselName = `${records[0].YachtName || 'Unknown'} (${records[0].SailNo || ''})`;
            verifiedCertRef = records[0].RefNo || options.orcSelectedVesselToken;
            resolveActivePolarTarget(currentTWSRegime);
            app.debug(`[ORC Sync Complete] Target Matrix Locked for: ${verifiedVesselName}`);
          }
        } catch (e) {
          app.error(`Failed parsing target polar data from registry: ${e.message}`);
        }
      });
    }).on('error', (err) => app.error(`Network communication error: ${err.message}`));
  }

  function makeHttpRequest(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', (err) => reject(err));
    });
  }

  function resolveActivePolarTarget(twsKnots) {
    if (!options.polarData) return;
    const allowances = options.polarData;
    const isGybeMode = options.maneuverMode === 'gybe';
    const windSpeeds = allowances.WindSpeeds || orcWindSpectrum;
    
    let targetIdx = windSpeeds.indexOf(twsKnots);
    if (targetIdx === -1) {
      targetIdx = windSpeeds.reduce((prev, curr, idx) => 
        Math.abs(curr - twsKnots) < Math.abs(windSpeeds[prev] - twsKnots) ? idx : prev, 0);
    } 

    if (!isGybeMode) {
      const beatAngles = allowances.BeatAngle || [46, 43, 40.5, 38.8, 37.8, 37.8, 37.4, 37.3, 38.1];
      const beatSecondsPerMile = allowances.Beat || [1200.2, 855.1, 713.4, 654.3, 631.4, 615.5, 605.5, 595.9, 599.2];
      orcTargetAngle = beatAngles[targetIdx] || 37.8;
      orcTargetSTW = 3600 / (beatSecondsPerMile[targetIdx] || 615.5);
    } else {
      const gybeAngles = allowances.GybeAngle || [139.2, 142.1, 145.6, 148.2, 152.8, 152.0, 150.1, 144.8, 144.4];
      const runSecondsPerMile = allowances.Run || [1235.2, 850.1, 673.7, 571.0, 510.4, 476.4, 445.2, 371.7, 291.0];
      orcTargetAngle = gybeAngles[targetIdx] || 152.0;
      orcTargetSTW = 3600 / (runSecondsPerMile[targetIdx] || 476.4);
    }
  }

  function generateAndBroadcastNMEA() {
    simStep++;
    
    let performanceUpdateTicks = (options.perfUpdateInterval || 5) * 10; 
    if (simStep % performanceUpdateTicks === 1 || simStep === 1) {
      let currentIdx = orcWindSpectrum.indexOf(currentTWSRegime);
      let nextIdx = (currentIdx + 1) % orcWindSpectrum.length;
      currentTWSRegime = orcWindSpectrum[nextIdx];

      let minPerf = (options.minPerformance || 92) / 100;
      let maxPerf = (options.maxPerformance || 98) / 100;
      randomVarianceScalar = minPerf + (Math.random() * (maxPerf - minPerf));
      
      resolveActivePolarTarget(currentTWSRegime); 
    }

    let isGybeMode = options.maneuverMode === 'gybe';
    let baseSTWKnots = orcTargetSTW * randomVarianceScalar;

    let totalLoopTicks = (options.maneuverInterval || 45) * 10;
    let loopStep = simStep % totalLoopTicks;

    if (loopStep === 0 && simStep > 1) {
      isCurrentlyStarboard = !isCurrentlyStarboard;
    }

    let side = isCurrentlyStarboard ? 1 : -1;
    let entryAwa = orcTargetAngle * side;  
    let exitAwa = -orcTargetAngle * side; 
    let dynamicOvershootAwa = isGybeMode ? -((orcTargetAngle - 10) * side) : -((orcTargetAngle + 10) * side); 

    let currentSTWKnots = baseSTWKnots;
    let currentAWADeg = entryAwa;
    let currentRudderDeg = 0.0;

    if (isGybeMode) {
      if (loopStep >= 0 && loopStep < 30) {
        let progress = loopStep / 30;
        currentRudderDeg = -5 * side * progress; 
        currentAWADeg = entryAwa + (((180 * side) - entryAwa) * progress);
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
        currentAWADeg = rawSweep > 180 ? rawSweep - 360 : (rawSweep < -180 ? rawSweep + 360 : rawSweep);
        currentSTWKnots = (baseSTWKnots * 0.90) - ((baseSTWKnots * 0.25) * Math.sin(progress * Math.PI / 2));
      }
      else if (loopStep >= 70 && loopStep < 170) {
        let progress = (loopStep - 70) / 100;
        currentRudderDeg = 4 * side * (1 - progress); 
        currentAWADeg = dynamicOvershootAwa + ((exitAwa - dynamicOvershootAwa) * Math.pow(progress, 2));
        currentSTWKnots = (baseSTWKnots * 0.65) + ((baseSTWKnots - (baseSTWKnots * 0.65)) * Math.sqrt(progress));
      }
      else {
        currentAWADeg = exitAwa;
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
        currentSTWKnots = (baseSTWKnots * 0.85) - ((baseSTWKnots * 0.45) * Math.sin(progress * Math.PI / 2));
      }
      else if (loopStep >= 70 && loopStep < 170) {
        let progress = (loopStep - 70) / 100;
        currentRudderDeg = -2 * side * (1 - progress);
        currentAWADeg = dynamicOvershootAwa + ((exitAwa - dynamicOvershootAwa) * Math.pow(progress, 2));
        currentSTWKnots = (baseSTWKnots * 0.40) + ((baseSTWKnots - (baseSTWKnots * 0.40)) * Math.sqrt(progress));
      }
      else {
        currentAWADeg = exitAwa;
      }
    }

    let awaRad = (currentAWADeg * Math.PI) / 180;
    let awsKnots = currentTWSRegime; 
    
    let apparentX = awsKnots * Math.cos(awaRad) - currentSTWKnots;
    let apparentY = awsKnots * Math.sin(awaRad);
    let derivedTWADeg = Math.abs(Math.atan2(apparentY, apparentX) * 180 / Math.PI);

    let twaRad = (derivedTWADeg * Math.PI) / 180;
    let rawVMGKnots = Math.abs(currentSTWKnots * Math.cos(twaRad));
    filteredVMG = filteredVMG + dampingFactor * (rawVMGKnots - filteredVMG);

    let vhwSentence = appendChecksum(`IIVHW,,T,,M,${currentSTWKnots.toFixed(2)},N,,K`);
    let awaFormatted = currentAWADeg < 0 ? 360 + currentAWADeg : currentAWADeg;
    let mwvApparentSentence = appendChecksum(`IIMWV,${awaFormatted.toFixed(1)},R,${awsKnots.toFixed(1)},N,A`);
    let twaFormatted = currentAWADeg < 0 ? 360 - derivedTWADeg : derivedTWADeg;
    let mwvTrueSentence = appendChecksum(`IIMWV,${twaFormatted.toFixed(1)},T,${currentTWSRegime.toFixed(1)},N,A`);
    let vmgSentence = appendChecksum(`IIVMG,${filteredVMG.toFixed(2)},N,,`);
    let rsaSentence = appendChecksum(`IIRSA,${currentRudderDeg.toFixed(1)},A,,`);

    const payload = `${vhwSentence}\r\n${mwvApparentSentence}\r\n${mwvTrueSentence}\r\n${vmgSentence}\r\n${rsaSentence}\r\n`;
    udpClient.send(payload, 2222, '127.0.0.1');
  }

  function appendChecksum(sentenceWithoutSign) {
    let checksum = 0;
    for (let i = 0; i < sentenceWithoutSign.length; i++) checksum ^= sentenceWithoutSign.charCodeAt(i);
    return `$${sentenceWithoutSign}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
  }

  plugin.stop = function () {
    if (simInterval) clearInterval(simInterval);
  };

  plugin.schema = {
    type: 'object',
    title: 'H5000 Dynamic ORC Fleet Registry Simulator',
    properties: {
      enableSimulation: { type: 'boolean', title: 'Enable Simulator Output Feed', default: false },
      maneuverMode: { type: 'string', title: 'Maneuver Track', default: 'tack', enum: ['tack', 'gybe'] },
      maneuverInterval: { type: 'number', title: 'Maneuver Interval (Seconds)', default: 45 },
      perfUpdateInterval: { type: 'number', title: 'Wind Step Interval (Seconds)', default: 10 },
      orcCountryId: { 
        type: 'string', 
        title: '1. Country Prefix Code (3-Letters)', 
        default: 'SWE',
        description: 'Type a country code (e.g. SWE, USA, GBR, GER, FRA) and hit Save to load its boats.'
      },
      orcSelectedVesselToken: { 
        type: 'string', 
        title: '2. Select Active Certificate Profile', 
        default: 'None',
        enum: ['None'],
        enumNames: ['Type a country prefix and save to pull fleet records...']
      },
      minPerformance: { type: 'number', title: 'Min Performance (%)', default: 92 },
      maxPerformance: { type: 'number', title: 'Max Performance (%)', default: 98 }
    }
  };

  return plugin;
};