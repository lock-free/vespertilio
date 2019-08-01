const {
  spawnp,
  mkdirp,
  writeTxt,
} = require('flexdeploy/src/util');
const path = require('path');
const del = require('del');

const copyDir = async (srcDir, tarDir) => {
  await mkdirp(tarDir);
  await del([tarDir]);
  await spawnp('cp', ['-r', srcDir, tarDir]);
};

const writeJson = async (tar, def = {}) => {
  await writeTxt(tar,
    JSON.stringify(
      def,
      null,
      4
    )
  );
};

const resolveConfigPath = (config, defaultName) => {
  return path.resolve(process.cwd(), config || defaultName);
};

module.exports = {
  copyDir,
  writeJson,
  resolveConfigPath
};
