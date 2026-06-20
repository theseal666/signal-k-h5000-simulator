B&G H5000 Network Simulator
A high-performance Signal K plugin that simulates a sailing vessel's instrument data by parsing ORC VPP polars and broadcasting NMEA 0183 sentences over UDP.
Overview
This plugin bridges the gap between static ORC certificate data and live instrument feeds. It calculates target performance metrics (STW, TWA, VMG) and generates a simulated UDP stream at 10Hz, allowing you to test MFDs, displays, and navigation software without being on the water.
Features
Live Polar Integration: Dynamically fetches and parses ORC RMS database records.
NMEA 0183 Broadcasting: Emits high-frequency standard sentences (VHW, MWV, VMG, RSA) over UDP port 2222.
Signal K Integration: Streams real-time performance deltas directly to the server core.
Configurable Fidelity: Adjustable wind intervals, performance filters, and maneuver simulation (tack/gybe modes).
Installation
Ensure the plugin directory is placed in ~/.signalk/node_modules/signal-k-h5000-simulator.
Ensure package.json includes the required signalk metadata blocks.
Restart the Signal K server.
Enable the plugin via Plugin Configuration in the Signal K dashboard.
Configuration
Yacht Name & Country: Set these in the plugin settings to fetch the correct ORC certificate from the public database.
Performance Range: Adjust the Min/Max filters to simulate different levels of crew/vessel efficiency.
For development, the plugin hosts a webapp via the public/ directory, accessible through the Signal K application dock.
