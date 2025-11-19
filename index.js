#!/usr/bin/env node

const fs = require('fs');
const { parseStringPromise } = require('xml2js');
const { Client } = require('@elastic/elasticsearch');

function flattenObject(obj, prefix = '') {
  const flattened = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flattened, flattenObject(value, newKey));
    } else {
      flattened[newKey] = value;
    }
  }

  return flattened;
}

async function convertJUnitToNDJSONObject(inputFile, testRun) {
  try {
    const xmlContent = fs.readFileSync(inputFile, 'utf8');
    const result = await parseStringPromise(xmlContent);

    const testsuites = result.testsuites;
    const testsuiteMetadata = {
      name: testsuites.$.name,
      totalTests: parseInt(testsuites.$.tests),
      failures: parseInt(testsuites.$.failures),
      errors: parseInt(testsuites.$.errors),
      uuid: testsuites.$.uuid,
      "@timestamp": testsuites.$.timestamp,
      totalDuration: parseFloat(testsuites.$.time)
    };

    const documents = [];

    for (const testsuite of testsuites.testsuite) {
      const suiteName = testsuite.$.name;

      for (const testcase of testsuite.testcase) {
        const doc = {
          testSuite: suiteName,
          testName: testcase.$.name,
          className: testcase.$.classname,
          "@timestamp": testcase.$.timestamp,
          duration: parseFloat(testcase.$.time),
          runnerName: testRun.runnerName,
          runId: testRun.runId,
          extra: testRun.extra,
          hasFailure: false,
          hasFlakyFailure: false,
          testsuiteMetadata
        };

        // Check for flaky failure
        if (testcase.flakyFailure && testcase.flakyFailure.length > 0) {
          const flakyFailure = testcase.flakyFailure[0];
          doc.hasFlakyFailure = true;
          doc.status = 'flaky';
          doc.flakyFailure = {
            "@timestamp": flakyFailure.$.timestamp,
            duration: parseFloat(flakyFailure.$.time),
            message: flakyFailure.$.message,
            type: flakyFailure.$.type,
            details: flakyFailure._ || ''
          };

          // Include nested system-out and system-err from flaky failure
          if (flakyFailure['system-out'] && flakyFailure['system-out'].length > 0) {
            doc.flakyFailure.systemOut = flakyFailure['system-out'][0];
          }
          if (flakyFailure['system-err'] && flakyFailure['system-err'].length > 0) {
            doc.flakyFailure.systemErr = flakyFailure['system-err'][0];
          }
        }

        // Check for regular failure
        if (testcase.failure && testcase.failure.length > 0) {
          const failure = testcase.failure[0];
          doc.hasFailure = true;
          doc.status = 'failed';
          doc.failure = {
            message: failure.$.message || '',
            type: failure.$.type || '',
            details: failure._ || ''
          };
        }

        // If no failures, mark as passed
        if (!doc.hasFailure && !doc.hasFlakyFailure) {
          doc.status = 'passed';
        }

        // Add system output
        if (testcase['system-out'] && testcase['system-out'].length > 0) {
          doc.systemOut = testcase['system-out'][0];
        }

        if (testcase['system-err'] && testcase['system-err'].length > 0) {
          doc.systemErr = testcase['system-err'][0];
        }

        documents.push(flattenObject(doc));
      }
    }

    return documents;
  } catch (error) {
    console.error('Error converting file:', error);
    process.exit(1);
  }
}

async function uploadToElasticsearch(documents, esConfig) {
  try {
    const clientConfig = {
      node: esConfig.url,
      serverMode: esConfig.serverMode,
      auth: {
        apiKey: esConfig.apiKey
      }
    };

    const client = new Client(clientConfig);

    // Test connection
    console.log(`\nConnecting to Elasticsearch at ${esConfig.url}...`);
    await client.ping();
    console.log('Connection successful!');

    // Prepare bulk operations
    const bulkOperations = [];
    for (const doc of documents) {
      // Add index action
      bulkOperations.push({
        index: { _index: esConfig.index }
      });
      // Add document
      bulkOperations.push(doc);
    }

    // Execute bulk upload
    console.log(`\nUploading ${documents.length} documents to index "${esConfig.index}"...`);
    const bulkResponse = await client.bulk({
      operations: bulkOperations,
      refresh: true
    });

    if (bulkResponse.errors) {
      const erroredDocuments = [];
      bulkResponse.items.forEach((action, i) => {
        const operation = Object.keys(action)[0];
        if (action[operation].error) {
          erroredDocuments.push({
            status: action[operation].status,
            error: action[operation].error,
            document: documents[Math.floor(i / 2)]
          });
        }
      });
      console.error(`\n❌ Upload completed with ${erroredDocuments.length} errors:`);
      erroredDocuments.slice(0, 5).forEach((err, idx) => {
        console.error(`  ${idx + 1}. ${err.error.type}: ${err.error.reason}`);
      });
      if (erroredDocuments.length > 5) {
        console.error(`  ... and ${erroredDocuments.length - 5} more errors`);
      }
    } else {
      console.log(`✅ Successfully uploaded ${documents.length} documents!`);
      console.log(`   Took: ${bulkResponse.took}ms`);
    }

  } catch (error) {
    console.error('\n❌ Error uploading to Elasticsearch:', error);
    if (error.meta?.body?.error) {
      console.error('   Details:', JSON.stringify(error.meta.body.error, null, 2));
    }
    process.exit(1);
  }
}

// Parse CLI arguments
function parseArgs(args) {
  const config = {
    inputFile: null,
    esConfig: {
      url: null,
      index: null,
      apiKey: null,
      serverMode: null,
    },
    testRun: {
      runnerName: null,
      runId: null,
      extra: null,
    }
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--es-url') {
      config.esConfig.url = args[++i];
    } else if (arg === '--es-index') {
      config.esConfig.index = args[++i];
    } else if (arg === '--es-api-key') {
      config.esConfig.apiKey = args[++i];
    } else if (arg === '--es-server-mode') {
      config.esConfig.serverMode = args[++i];
    } else if (arg === '--runner-name') {
      config.testRun.runnerName = args[++i];
    } else if (arg === '--run-id') {
      config.testRun.runId = args[++i];
    } else if (arg === '--extra') {
      config.testRun.extra = args[++i];
    } else if (!config.inputFile) {
      config.inputFile = arg;
    }
  }

  return config;
}

// CLI usage
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log('Usage: junit-to-elasticsearch <input.xml> --es-url <url> --es-index <index> --es-server-mode <server mode> --es-api-key <key>');
  console.log('\nExamples:');
  console.log('  junit-to-elasticsearch junit.xml --es-url https://elastic.example.com --es-server-mode serverless --es-index test-results --es-api-key YOUR_BASE64_API_KEY');
  process.exit(1);
}

const config = parseArgs(args);
const inputFile = config.inputFile;

// Validate Elasticsearch config
if (!config.esConfig.url || !config.esConfig.index || !config.esConfig.apiKey || !config.esConfig.serverMode) {
  console.error('Error: requires --es-url and --es-index and --es-api-key and --es-server-mode to be specified');
  process.exit(1);
}

// Main execution
(async () => {
  const ndjsonObj = await convertJUnitToNDJSONObject(inputFile, config.testRun);

  await uploadToElasticsearch(ndjsonObj, config.esConfig);
})();
