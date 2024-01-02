// Synthetic scripted API to maintain relationships between OTEL services and hosts monitored by the New Relic Infra agent.
// Script runs from the bottom up, to do the following:
// - Get a list of all OTEL services.
// - For each OTEL service get a list of New Relic Infra monitored servers hosting a service.
// - For each OTEL service get a list of existing host relationships.
// - For each OTEL service compare the list of New Relic monitored hosts and the existing host relationships.
// - Create the missing host relationships.
// - Delete any stale host relationships.
//
// Script uses the following secure credentials:
// NR_ACCOUNT_ID - The account id the script is running against (The script runs aginst a single account).
// NR_USER_LICENSE_KEY - A user key for accessing data within the account.


var assert = require('assert');

// Number of hours to look back over for relationships
const hours = 6;

// Query to get OTEL service details
const NRQL_OTEL_Services = "SELECT count(*) FROM Span WHERE newrelic.source = 'api.traces.otlp' AND entity.type = 'SERVICE' FACET entity.name, entityGuid SINCE " +
  hours + " hour ago LIMIT MAX";

// Query to find any New Relic infra hosts related to a given OTEL service
// This query will match on the hostname and ignores fully qualified domain names.
// For example machine.company.com would match with machine.
// You might want to change this logic!
function getHostNRQL(guid) {
  return "FROM SystemSample JOIN (FROM Span SELECT count(*) WHERE entity.guid = '" + guid +
    "' FACET aparse(concat(host.name, '.'), '*.%') AS hostname LIMIT MAX since " + hours +
    " hours ago) ON hostname SELECT count(*) FACET hostname, entityGuid LIMIT MAX since " + hours + " hours ago";
}

// Function to get a formatted NerGraph body from a NRQL query.
function getNRQLBody(nrql) {
  return '{"query": "{ actor { account(id: ' + $secure.NR_ACCOUNT_ID + ') { nrql(query: \\\"' + nrql + '\\\") { totalResult results }}}}"}';
}

// Function to return a formatted NerdGraph body for getting all host relationships for a given GUID.
// This also returns the associated tags, as we need to check them to ensure the host is monitored by New Relic infra and not OTEL.
function getRelationshipsBody(guid, cursr) {
  return '{"query": "{actor {entity(guid: \\\"' + guid +
    '\\\") {relatedEntities(filter: {entityDomainTypes: {include: {type: \\\"HOST\\\", domain: \\\"INFRA\\\"}}, relationshipTypes: {include: HOSTS}}, cursor: \\\"' +
    cursr + '\\\") {results { source { entity { name guid tags { key values }}}} nextCursor }}}}"}';
}

// Function to return the correct mutation type - delete or create.
function getCreateDeleteMutation(delte) {
  if (delte) {
    return "entityRelationshipUserDefinedDelete";
  } else {
    return "entityRelationshipUserDefinedCreateOrReplace";
  }  
}

// Function to get a formatted NerdGraph body for creating or deleting relationships.
function createDeleteRelationshipBody(hostGUID, serviceGUID, delte) {
  return '{"query": "mutation {' + getCreateDeleteMutation(delte) + '(sourceEntityGuid: \\\"' +
    hostGUID + '\\\", targetEntityGuid: \\\"' + serviceGUID + '\\\", type: HOSTS) {errors {message type}}}", "variables": null}';
}

// Function to create the NerdGraph post options
function getPostOptions(bdy) {
  return {
    // Set the correct URL
    uri: 'https://api.eu.newrelic.com/graphql',
    //uri: 'https://api.newrelic.com/graphql',
  body: bdy,
  headers: {
    'Content-Type': 'application/json',
    'API-Key': $secure.NR_USER_LICENSE_KEY
  }
  };
}

// Function to create or delete a relationship.
// If delte is set to true then we will delete the relationship, if it is false then we will create it.
function createDeleteRelationship(hostGUID, serviceGUID, delte) {
    $http.post(getPostOptions(createDeleteRelationshipBody(hostGUID, serviceGUID, delte)),
    // Callback function
    function (err, response, body) {
      // Get the mutation type: create or delete.
      let mutation = getCreateDeleteMutation(delte);
      assert.equal(response.statusCode, 200, 'Expected a 200 OK response from ' + mutation + ', hostGUID: ' + hostGUID + ', serviceGUID: ' + serviceGUID);
      if (body.data[mutation].errors.length > 0) {
        // Check for any errors returned by the mutation.
        for (let i = 0; i < body.data[mutation].errors.length; i++) {
          console.log("createDeleteRelationships error, type: " + body.data[mutation].errors[i].type + ", message: " + body.data[mutation].errors[i].message);
        }
      }
    }
  );
}

// Function to take an array of hosts and host relationships for a given OTEL service and check they are correct
function processRelationships(serviceName, serviceGUID, hostArray, relationshipArray) {
  console.log("Processing relationships for service " + serviceName + ", " + hostArray.length + " hosts and " + relationshipArray.length + " relationships.");
  // Loop through the hosts found for this OTEL service
  for (let i = 0; i < hostArray.length; i++) {
    let relFound = false;
    let j = 0;
    // Does the relationship exist for this host?
    while (!relFound && j < relationshipArray.length) {
      // IS the guid for the host and host relationship the same?
      if (hostArray[i].guid === relationshipArray[j]) {
        relFound = true;
        // If we have a match then remove the relationship from the relationship array.
        relationshipArray.splice(j, 1);
      }
      j++
    }
    if (!relFound) {
      // If the relationship was not found then we need to create it.
      console.log("Creating relationship for service " + serviceName + ", host " + hostArray[i].hostName);
      createDeleteRelationship(hostArray[i].guid, serviceGUID, false);
    }
  }
  for (let k = 0; k < relationshipArray.length; k++) {
    // We went through deleting relationships from the relationship array for each host.
    // Any relationships left are old and should be deleted.
    console.log("Deleting relationship for service " + serviceName + ", host guid " + relationshipArray[k]);
    createDeleteRelationship(relationshipArray[k], serviceGUID, true);
  }
}

// Function to get the existing host relationships for an OTEL service
function getRelationships(serviceName, serviceGUID, hostArray, cursr, relArray) {
  console.log("Found " + hostArray.length + " hosts for OTE service: " + serviceName);
    $http.post(getPostOptions(getRelationshipsBody(serviceGUID, cursr)),
    // Callback function
    function (err, response, body) {
      assert.equal(response.statusCode, 200, 'Expected a 200 OK response from getServers: ' + serviceName);
      if (!err && response.statusCode === 200) {
        // Build an array of relationships for this service
        // Check the JSON structure is correct, sometimes the entity attribute seems to be missing!
        if (body.data.actor.entity) {
          let jsn = [];
          if (body.data.actor.entity.relatedEntities) {
            jsn = body.data.actor.entity.relatedEntities.results;
          }
          // Copy the array passed in.
          let relationshipArray = relArray.slice();
          for (let i = 0; i < jsn.length; i++) {
            // We need to check if the host is a New Relic infra host and not OTEL.
            let newRelicInfra = false;
            // Search in the tags for agentName: Infrastructure
            if (jsn[i].source.entity.name && jsn[i].source.entity.tags) {
              let j = 0;
              while (!newRelicInfra && j < jsn[i].source.entity.tags.length) {
                // If we have found the right tag then we can add the relationship to our array
                if (jsn[i].source.entity.tags[j].key === "agentName" && jsn[i].source.entity.tags[j].values[0] === "Infrastructure") {
                  newRelicInfra = true;
                  // Add the host relationship to the array
                  relationshipArray.push(jsn[i].source.entity.guid);
                  console.log("Found relationship for service " + serviceName + ", host " + jsn[i].source.entity.name);
                 }
                j++;
              }
            }
          }
          // If we have a nextCursor then we need to recursively call the function
          if (body.data.actor.entity.relatedEntities && body.data.actor.entity.relatedEntities.nextCursor) {
            getRelationships(serviceName, serviceGUID, hostArray, body.data.actor.entity.relatedEntities.nextCursor, relationshipArray);
          } else {
            // We have all the relationships, record if we didn't find any
            if (relationshipArray.length === 0) {
              console.log("No relationships found for service: " + serviceName);
            }
            // If we have somehting to process then start processing the relationships!
            if (relationshipArray.length > 0 || hostArray.length > 0) {
              processRelationships(serviceName, serviceGUID, hostArray, relationshipArray);
            }
          }
        }
      }
    }
  );
}

// Function to get an array of New Relic infra hosts for a supplied OTEL service
function getHosts(serviceName, serviceGUID) {
  console.log('Found OTEL service: ' + serviceName + ", GUID: " + serviceGUID);
  $http.post(getPostOptions(getNRQLBody(getHostNRQL(serviceGUID))),
    // Callback function
    function (err, response, body) {
      assert.equal(response.statusCode, 200, 'Expected a 200 OK response from getServers: ' + serviceName);
      if (!err && response.statusCode === 200) {
        // Build an array of New Relic infra hosts
        let jsn = body.data.actor.account.nrql.results;
        // Start with an empty array
        let hostArray = [];
        for (let i = 0; i < jsn.length; i++) {
          // Add the host name and guid for each host
          const arrayItem = {hostName: jsn[i].facet[0], guid: jsn[i].facet[1]};
          hostArray.push(arrayItem);
        }
        // Now get the existing relationships for this service, passing in what we have found so far.
        // Set the cursor to null for the first call and relationship array to an empty array.
        getRelationships(serviceName, serviceGUID, hostArray, null, []);
      }
    }
  );
}

// Main code - Get a list of all the OTEL services sending traces
$http.post(getPostOptions(getNRQLBody(NRQL_OTEL_Services)),
 // Callback function
 function (err, response, body) {
   assert.equal(response.statusCode, 200, 'Expected a 200 OK response from Create relationships main.');
   if (!err && response.statusCode === 200) {
    // Get the OTEL services and get a list of New Relic infra monitored hosts for each service
    let jsn = body.data.actor.account.nrql.results;
     for (let i = 0; i < jsn.length; i++) {
       let name = jsn[i].facet[0];
       let guid = jsn[i].facet[1];
       getHosts(name, guid);
     }
   }
 }
);
