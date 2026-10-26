// Public settings. The anon key is meant to be public: what each login can read is
// enforced by row security in the database, not by hiding this key.
window.ROOM = {
  url: 'https://qnoonqzxrtppowlxaurl.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFub29ucXp4cnRwcG93bHhhdXJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwMjU0MTMsImV4cCI6MjEwODYwMTQxM30.BqZvbuY0Gz_5XoEQ9RKCAq5gBpZcyi8x6awl3P3b5Ro',
  // The server: every call carries the person's login token, and the server checks who they are
  server: 'https://jai-pipeline.app.n8n.cloud/webhook/pipeline-room',
  // Voice agents, one personality each
  agents: {
    checkin: 'agent_0701m5wfz4nxevf9898fvk8cj14h',
    briefer: 'agent_7301m5wnmtcsfj9rzyxpdwr2kyed',
    analyst: 'agent_2301m5wnmw53f7d8s7kpgcsgyfjt',
    mentor: 'agent_8801m5wnmxnpe0h93m7nbqz3f85p',
  },
};
