// What the admin's browser runs on a new Salesforce export: one record per deal, then the facts
const { ingest } = require('./ingest');
const { buildFacts, band } = require('./facts');
module.exports = { ingest, buildFacts, band };
