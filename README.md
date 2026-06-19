# B&G H5000 Network Simulator (UDP NMEA 0183)

A high-frequency performance testing utility for Signal K designed to mirror physical hardware data pipelines. Instead of injecting values directly into the server's internal memory store, this plugin broadcasts real-time physics data as raw, standard NMEA 0183 sentences over a local network UDP connection.

This ensures that your tactical performance tracking applications process the mock telemetry exactly as they would stream from a physical B&G H5000 CPU network gateway at sea.

---

## 📂 Repository File Structure

```text
signal-k-h5000-simulator/
├── index.js          # UDP NMEA 0183 Physics & Broadcast Engine
├── package.json      # Signal K Node Server Plugin Manifest
└── README.md         # Documentation & Ingestion Setup Guide




Core Functional Logic
The plugin operates on a 10Hz clock execution loop (every 100ms) to model real-world instrument update cycles:
1. High-Frequency Maneuver Simulation
When enabled, the plugin computes dynamic boat physics across four operational phases:
Phase 1 (Helm Entry): The rudder deflects smoothly up to 8 degrees (or -10 degrees downwind), sweeping the vessel into the maneuver.
Phase 2 (Apex Cross): The boat passes through the wind's eye (tacking) or downwind gybe dead-zone. Apparent wind angles shift, and velocity drops dynamically due to simulated sail drag and hull friction.
Phase 3 (Acceleration Build): Counter-steering sets in to hold the new course while the boat builds momentum and accelerates back toward target performance speeds.
Phase 4 (Steady-State Line): The boat locks onto its target baseline upwind or downwind tracking angle until the loop resets.
2. Random Performance Variance Range
To simulate real-world conditions (seastate, helm steering error, or changing wind velocity), the simulator scales its target speeds and angles using a random efficiency scalar mapped dynamically between your configured minPerformance and maxPerformance thresholds on every loop cycle.
3. Native Network Packaging
The computed physics attributes are packaged directly into standard marine sentences:
$IIVHW: Speed Through Water (STW) and Heading attributes.
$IIMWV: Relative/Apparent Wind Angle (AWA) and Apparent Wind Speed (AWS).
These sentences are given valid standard NMEA checksum signatures and blasted directly out of the container to local host UDP port 2222.
📈 Emitted Telemetry Data
NMEA Sentence	Captured Variable Mapping	Target Signal K Target Keys
$IIVHW	Speed Through Water	navigation.speedThroughWater
$IIMWV	Apparent Wind Angle	environment.wind.angleApparent
$IIMWV	Apparent Wind Speed	environment.wind.speedApparent
(Note: Signal K's core ingestion system will automatically derive True Wind Angle, True Wind Speed, and Upwind/Downwind Velocity Made Good vectors from these raw inputs).
⚙️ Connection Ingestion Setup
To channel this data into your tactical environment, you must register it as a standard network line in your Signal K administration dashboard:
Log into your Signal K Web Console.
Navigate to Server -> Data Connections inside the sidebar.
Click the Add Connection button and assign these parameters:
Data Connection ID: h5000-simulator-feed
Connection Type: NMEA 0183
NMEA 0183 Source: UDP
Port: 2222
Validate Checksums: True / Checked
Click Apply Changes and restart your Signal K server.
Once configured, toggle Enable Simulator Output Feed in this plugin's settings to start streaming. To switch back to using the boat's physical network instruments, simply turn this plugin's simulator switch to off.