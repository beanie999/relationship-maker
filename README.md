# Relationship Maker using Synthetics
This project provides and example Synthetic Scripted API script to maintain relationships between OTEL services and hosts monitored by the New Relic Infra agent.

## How it works
The monitor should run on a regular basis (say every hour), it will look for the servers hosting OTEL services and the existing relationships. It will then ensure the correct relationships are in place, either by creating new relationships or deleting existing ones.


## Setup
- Make sure you have a USER key and your account id, then create an Endpoint availability, Scripted API monitor (probably set to run once an hour). 
- Paste in the script.js JavaScript code.
- Ensure the USER key and account id are set correctly, the example uses 2 secure credentials (`NR_ACCOUNT_ID` and `NR_USER_LICENSE_KEY`). Create, rename or hardcode them, as appropriate.
- Ensure the correct API endpoint is set within the getPostOptions function.
- Examine the NRQL returned by the getHostNRQL function. The supplied function looks for the host name created by the New Relic Infra agent and compares it to the host.name attribute supplied by the OTEL service. You might want to do something different!
- Validate/test the monitor (you might want to comment out the calls to the createDeleteRelationship function within processRelationships the first time you run it, so it doesn't actually change any relationships!). Examine the Script log to ensure it is doing what you expect and finally set it running.
- Optionally, create an alert to watch for this specific monitor so you know if it encounters any issues going forward.
