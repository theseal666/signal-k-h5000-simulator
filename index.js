module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signal-k-h5000-simulator';
  plugin.name = 'B&G H5000 Network Simulator';
  plugin.description = 'Simulator';

  plugin.start = function (props) {
    app.debug('Plugin starting...');
  };

  plugin.stop = function () {
    app.debug('Plugin stopped.');
  };

  plugin.schema = {
    type: 'object',
    properties: {
      enable: { type: 'boolean', title: 'Enable', default: true }
    }
  };

  return plugin;
};