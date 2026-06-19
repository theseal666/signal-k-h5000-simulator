const dgram = require('dgram');
const https = require('https');
const path = require('path');

module.exports = function (app) {
  const plugin = {};
  let simInterval = null;
  let options = {};
  const udpClient = dgram.createSocket('udp4');

  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator';
  plugin.description = 'Broadcasts high-frequency simulated NMEA 0183 sentences over UDP port 2222 by dynamically parsing live ORC database certificates.';

  let simStep = 0;
  let isCurrentlyStarboard = true;
  let verifiedVesselName = 'None - Waiting for valid API sync...';
  let verifiedCertRef = 'None';

  let currentTWSRegime = 14.0;
  const orcWindSpectrum = [4, 6, 8, 10, 12, 14, 16, 20, 24];
  
  let orcTargetSTW = 5.85;   
  let orcTargetAngle = 37.8; 
  let randomVarianceScalar = 0.95; 

  let filteredVMG = 0.0;
  const dampingFactor = 0.033;

  plugin.signalKApiRoutes = function (router) {
    const express = require('express');
    router.use('/', express.static(path.join(__dirname, 'public')));
    return router;
  };

  plugin.start = function (startOptions) {
    options = startOptions || {};
    isCurrentlyStarboard = true;

    // Direct mapping to your specific Webapp Key definitions
    const searchName = options.orcYachtName ? options.orcYachtName.trim() : 'Oxygen';
    const searchCountry = options.orcCountryId ? options.orcCountryId.trim() : 'SWE';

    fetchOrcPolarMatrixByName(searchName, searchCountry);

    if (options.enableSimulation !== false) { 
      simInterval = setInterval(() => {
        generateAndBroadcastNMEA();
      }, 100);
    }
  };

  function fetchOrcPolarMatrixByName(yachtName, countryId) {
    const url = `https://data.orc.org/public/WPub.dll?action=DownBoatRMS&YachtName=${encodeURIComponent(yachtName)}&CountryId=${encodeURIComponent(countryId)}&ext=json`;
    
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          let recordArray = data && data.rms ? data.rms : (Array.isArray(data) ? data : []);

          if (recordArray.length > 0) {
            let activeBoatRecord = recordArray.find(boat => 
              boat.YachtName && boat.YachtName.trim().toLowerCase() === yachtName.toLowerCase()
            );

            if (!activeBoatRecord) activeBoatRecord = recordArray[0];
            
            if (activeBoatRecord && activeBoatRecord.Allowances) {
              options.polarData = activeBoatRecord.Allowances;
              
              const craftName = activeBoatRecord.YachtName || yachtName;
              const sailNum = activeBoatRecord.SailNo || '';
              
              verifiedVesselName = sailNum ? `${craftName} (${sailNum})` : craftName;
              verifiedCertRef = activeBoatRecord.RefNo || 'Found';
              
              resolveActivePolarTarget(currentTWSRegime); 
            }
          }
        } catch (e) {
          // Robust empty catch block to avoid breaking registration list
        }
      });
    }).on('error', (err) => {});
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
    
    // Aligns backend loop directly with your UI's windStepInterval input
    let stepInterval = (options.windStepInterval || 300) * 10; 
    if (simStep % stepInterval === 1 || simStep === 1) {
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

  // Re-aligned configuration schema structural parameters to mirror UI perfectly
  plugin.schema = {
    type: 'object',
    title: 'H5000 Network UDP Simulator Controls',
    properties: {
      enableSimulation: { type: 'boolean', title: 'Enable Simulator Output Feed', default: true },
      windStepInterval: { type: 'number', title: 'Wind Step Interval (Seconds)', default: 300 },
      orcYachtName: { type: 'string', title: 'ORC Yacht Name Lookup Field', default: 'Oxygen' },
      orcCountryId: { type: 'string', title: 'ORC Country Prefix Code', default: 'SWE' },
      minPerformance: { type: 'number', title: 'Minimum Target Performance Filter Range (%)', default: 92 },
      maxPerformance: { type: 'number', title: 'Maximum Target Performance Filter Range (%)', default: 98 }
    }
  };

  return plugin;
};