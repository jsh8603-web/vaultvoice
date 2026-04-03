module.exports = async function globalTeardown() {
  const server = global.__mockGeminiServer;
  if (server && server.listening) {
    await new Promise((r) => server.close(r));
    console.log('[MockGemini] Global server closed');
  }
};
