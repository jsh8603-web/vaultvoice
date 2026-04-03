process.env.VAULT_PATH = 'D:/projects/vaultvoice/test-vault';
require('dotenv').config({ path: '.env.test', override: true });
process.env.DOTENV_LOADED = 1;
require('./server.js');
