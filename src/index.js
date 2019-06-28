const {
  spawnp
} = require('flexdeploy/src/util');

const deployDpm = async (dpmDeployCnfPath, onlineType) => {
  await spawnp(
    '../node_modules/.bin/ideploy',
    //'../../insight-in-one/thirdparty/flexdeploy/bin/ideploy',

    [
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
