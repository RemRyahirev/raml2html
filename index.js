require('babel-register')({
    presets: ['es2015']
});

var raml = require('./raml2html');

module.exports = {
    getDefaultConfig: raml.getDefaultConfig,
    render:           raml.render
};

if (require.main === module) {
    console.log('This script is meant to be used as a library. You probably want to run bin/raml2html if you\'re looking for a CLI.');
    process.exit(1);
}
