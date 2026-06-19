B&G H5000 Network Simulator & Wind Deriver
A high-frequency utility plugin for Signal K designed to complement tactical performance systems on the MAT 12.20 racing platform. This plugin serves a dual purpose: it acts as an onboarding mathematical vector deriver for live H5000 instrumentation data, and provides a standalone virtual tacking simulator for software integration testing without requiring real hardware connections.
📂 Repository File Structure
Plaintext
signal-k-h5000-simulator/
├── index.js          # Core Math Deriver, Vector Physics & Telemetry Generator
├── package.json      # Signal K Node Server Configuration Meta-data
└── README.md         # Documentation & Trigonometric System Overview
🧠 Core Functional Logic
The plugin operates on a high-frequency 10Hz execution clock loop (every 100ms) executing two core tasks depending on your settings:
1. Vector Mapping (Live Bridge Mode)
When running normally on the boat's network, the plugin listens for raw, uncalibrated inputs streaming from the B&G H5000 network processor. It captures:
Speed Through Water (STW)
Rudder Angle
Apparent Wind Angle (AWA)
Apparent Wind Speed (AWS)
Because raw instruments can only calculate values relative to the moving boat frame, the plugin uses native coordinate vector transforms to subtract the vessel's forward motion from the apparent wind profile. This isolates the absolute true wind grid and emits clean, derived updates for:
True Wind Angle (TWA)
True Wind Speed (TWS)
Velocity Made Good (VMG)
2. High-Frequency Maneuver Simulation (Test Mode)
When enableSimulation is toggled true via the control panel, the plugin detaches from live network sockets and takes control of the local bus. It starts broadcasting automated 30-second tacking performance sequences:
Phase A (0s to 1.5s): The rudder deflects smoothly up to 8 
∘
 , tracking the initial turn into the weather couch.
Phase B (1.5s to 5.0s): The helm hits max apex angle (12 
∘
 ), passing directly through the wind's eye while simulating sail drag and hull friction velocity drops.
Phase C (5.0s to 20.0s): Counter-steering sets in to break the turn, dropping the bow to a low exit angle to accelerate out of the speed hole back toward steady-state performance polars.
Phase D (20.0s to 30.0s): The boat trims back to optimal close-hauled tracks on the new boards before repeating the loop.
📈 Emitted Signal K Delta Keys
This plugin calculates, maps, and updates these standard Signal K open data keys at a steady 10Hz stream:
Delta Path Key	Unit	System Role
navigation.speedThroughWater	m/s	Longitudinal hull speed metric
steering.rudderAngle	rad	Deflection variance of helm foil
environment.wind.angleApparent	rad	Measured raw wind direction angle
environment.wind.speedApparent	m/s	Measured raw wind speed velocity
environment.wind.angleTrueWater	rad	Derived: Velocity vector true wind angle
environment.wind.speedTrue	m/s	Derived: Velocity vector true wind strength
navigation.velocityMadeGood	m/s	Derived: Calculated upwind efficiency progress
⚙️ Configuration Dashboard Settings
Adjust these controls directly inside your Signal K Server -> Plugin Configuration web dashboard:
Enable Virtual Tacking Simulator: Toggling this checkbox instantly overrides active NMEA network wires and streams clean, artificial tacking curves for debugging and dashboard calibration (Default: false).
Simulation Base Speed (Knots): Sets the unhampered, steady-state upwind hull speed velocity baseline matching your MAT 12.20 VPP tables (Default: 7.80 kn).
