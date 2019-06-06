const {
  spawnp
} = require('flexdeploy/src/util');

const deployDpm = async (dpmDeployCnfPath, onlineType) => {
  await spawnp('../node_modules/.bin/ideploy', [
    '--config',
    dpmDeployCnfPath,
    '--onlineType',
    onlineType
  ], {
    cwd: __dirname,
    stdio: 'inherit'
  });
};

module.exports = {
  deployDpm
};
