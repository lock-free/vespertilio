const path = require('path');
const del = require('del');
const _ = require('lodash');
const {
  spawnp,
  exec,
  existsDir,
  mkdirp,
  parseTpl,
  writeTxt
} = require('flexdeploy/src/util');
const {
  copyDir,
  writeJson,
  log
} = require('./util');

const deployDpm = async (dpmDeployCnfPath, onlineType) => {
  await spawnp(
    '../node_modules/.bin/ideploy',
    // '../../insight-in-one/thirdparty/flexdeploy/bin/ideploy',

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

const getVespertilioConf = async ({
  configObject,
  only,
  cnfDir
}) => {
  const cnf = Object.assign(configObject, {
    only
  });

  cnf.cwd = cnfDir;

  const localDir = cnf.localDir || 'vespertilio';
  const baseDir = `./${localDir}/clusters/${cnf.name}`;
  const configDir = `./${localDir}/conf/${cnf.name}`;

  // generate machine confs
  _.merge(cnf, {
    machine: {
      na: {
        instances: {
          staging: cnf.machine.naHosts.map((host) => {
            return {
              host
            };
          })
        }
      },
      worker: {
        instances: {
          staging: cnf.machine.workerHosts.map((host) => {
            return {
              host
            };
          })
        }
      },
      dpm: {
        instances: {
          staging: cnf.machine.dpmHosts.map((host) => {
            return {
              host
            };
          })
        }
      }
    }
  });

  // merge with default configuration options
  _.merge(cnf, {
    build: {
      'repoRoot': `${baseDir}/code_repo`,
      dpm: {
        'deploy-cnf': `${baseDir}/dpm/deploy-cnf.json`,
        'src': `${baseDir}/dpm/src`,
        'cnfDir': `${configDir}/dpm/cnf`,
        'cnfFile': `${configDir}/dpm/config.json`,
        'data': `${configDir}/data`,
        deploy: cnf.machine.dpm
      }
    },
    deploy: {
      NAs: _.flatten(cnf.deploy.naPorts.map((port) => {
        return cnf.machine.na.instances.staging.map(({
          host
        }) => {
          return {
            Host: host,
            Port: port
          };
        });
      })),

      worker: {
        Machines: cnf.machine.worker.instances.staging.map(({
          host
        }) => {
          return {
            Host: host
          };
        })
      }
    }
  });

  // add automatic name and serviceType for deploy  worker
  cnf.deploy.workers = _.map(cnf.deploy.workers, (worker, serviceType) => {
    worker.serviceType = serviceType;
    worker.name = `${cnf.name}_${worker.serviceType}`;
    return worker;
  });

  cnf.build.workers = _.map(cnf.build.workers, (worker, serviceType) => {
    worker.serviceType = serviceType;
    return worker;
  });

  // resolve paths
  cnf.build.repoRoot = path.resolve(cnfDir, cnf.build.repoRoot);

  cnf.build.dpm.cnfDir = path.join(cnfDir, cnf.build.dpm.cnfDir);
  cnf.build.dpm.cnfFile = path.join(cnfDir, cnf.build.dpm.cnfFile);
  cnf.build.dpm.src = path.resolve(cnfDir, cnf.build.dpm.src);
  cnf.build.dpm['deploy-cnf'] = path.resolve(cnfDir, cnf.build.dpm['deploy-cnf']);

  cnf.privateKeyDir = path.resolve(cnfDir, cnf.privateKeyDir);

  return cnf;
};

const syncBaseProjects = async (cnf, {
  upd
}) => {
  // if need to force update demo project,
  if (!await existsDir(cnf.build.dpm.src) || upd) {
    await del([cnf.build.dpm.src]);
    await spawnp('git', ['clone', 'git@github.com:lock-free/dpm-cluster-demo.git', cnf.build.dpm.src]);
    await del([path.join(cnf.build.dpm.src, '.git')]);
  }

  await Promise.all([
    updateRepo('git@github.com:lock-free/dpm_service.git', cnf.build.repoRoot, 'dpm_service'),
    updateRepo('git@github.com:lock-free/na_service.git', cnf.build.repoRoot, 'na_service')
  ]);
};

const updateRepo = async (gitAddr, repoRoot, targetDir) => {
  const repoDir = path.resolve(repoRoot, targetDir);
  if (!await existsDir(repoDir)) {
    await spawnp('git', ['clone', gitAddr, repoDir]);
  } else {
    await spawnp('git', ['pull'], {
      cwd: repoDir
    });
  }
};

// copy stage dir and empty Makefile
const copyStageToDpmSrcRepo = async (repoRoot, srcRepo, targetDir, stageDir = 'stage') => {
  const srcStage = path.resolve(srcRepo, targetDir, 'stage');
  const repoStage = path.resolve(repoRoot, targetDir, stageDir);

  await copyDir(repoStage, srcStage);
  await spawnp('cp', [path.join(__dirname, '../res/makefile'), path.resolve(srcRepo, targetDir, 'makefile')]);
};

const getWorkers = (cnf) => {
  console.log(cnf.build.workers);
  return (
    cnf.only ? cnf.build.workers.filter(({
      serviceType
    }) => serviceType === cnf.only) : cnf.build.workers
  );
};

// copy projects to dpm source dir
const buildDpm = async (cnf) => {
  // copy binary
  const dpmBinPath = path.resolve(cnf.build.dpm.src, './stage/bin/');
  await mkdirp(dpmBinPath);
  await spawnp('cp', [path.resolve(cnf.build.repoRoot, 'dpm_service/stage/bin/dpm_service'), dpmBinPath]);

  // write docker-compose.yml
  await writeTxt(path.resolve(cnf.build.dpm.src, 'docker-compose.yml'), `
version: '3'
services:
  ${cnf.name}_dpm_service:
    container_name: ${cnf.name}_dpm_service
    build: ./stage
    volumes:
      - ./stage/data:/data
    network_mode: host
  `);

  // copy deploy-cnf.json to dpm dir
  await writeJson(cnf.build.dpm['deploy-cnf'],
    Object.assign({
      'project': cnf.name || 'vespertilio-cluster',

      'srcDir': './src',
      'stageDir': 'stage',
      'depDir': './src',

      'hooks': {
        'pre': [],
        'afterDeployRemoteCmds': []
      }
    }, cnf.build.dpm.deploy)
  );
};

const build = async (cnf, {
  upd
}) => {
  log('[sync base projects]');
  // sync base projects: dpm-cluster-demo, dpm_service, na_service, httpna_service
  await syncBaseProjects(cnf, {
    upd
  });

  log('[copy source code to domSrc]');
  await copySourceCodeToDpmSrc(cnf);

  const srcRepo = path.resolve(cnf.build.dpm.src, './stage/data/src');

  await Promise.all([
    await copyDpmData(cnf),
  ].concat(
    // copy workers data
    getWorkers(cnf).map(async ({
      serviceType
    }) => {
      // get deploy  worker
      const worker = _.find(cnf.deploy.workers, (worker) => serviceType === worker.serviceType);
      if (!worker) {
        throw new Error(`missing deploy worker configuration for worker ${serviceType}`);
      }

      log(`[write data files of worker ${serviceType}]`);
      // write data files
      await Promise.all(_.map(worker.data, (value, filename) => {
        return writeJson(path.join(srcRepo, serviceType, `./stage/data/${filename}`), value);
      }));
    })
  ));

  log('[build dpm]');
  await buildDpm(cnf);
};

// copy code to dpm src dir
const copySourceCodeToDpmSrc = async (cnf) => {
  const srcRepo = path.resolve(cnf.build.dpm.src, './stage/data/src');

  await Promise.all([
    // copy basic services
    await copyStageToDpmSrcRepo(cnf.build.repoRoot, srcRepo, 'na_service')
  ].concat(
    // copy workers
    getWorkers(cnf).map(async ({
      serviceType,
      buildCmd,
      stageDir
    }) => {
      // build first
      if (buildCmd) {
        await exec(parseTpl(buildCmd, cnf), {
          cwd: cnf.cwd
        });
      }
      // copy source from repo root to dpm src repo
      await copyStageToDpmSrcRepo(cnf.build.repoRoot, srcRepo, serviceType, stageDir);
    })));
};

const copyDpmData = async (cnf) => {
  // copy common dir
  if (await existsDir(path.join(cnf.build.dpm.cnfDir, 'common'))) {
    await copyDir(path.join(cnf.build.dpm.cnfDir, 'common'), path.join(cnf.build.dpm.src, './stage/data/cnf/common'));
  }

  // copy private dir
  if (await existsDir(path.join(cnf.build.dpm.cnfDir, 'private'))) {
    await copyDir(path.join(cnf.build.dpm.cnfDir, 'private'), path.join(cnf.build.dpm.src, './stage/data/cnf/private'));
  }

  // copy dpm cnf na.json on the fly
  await writeJson(path.join(cnf.build.dpm.src, './stage/data/cnf/na.json'), {
    'NADeployCnfPath': '/data/cnf/common/na/deploy-cnf.json',
    'NAMachineCnfPath': '/data/cnf/private/machine/na.json',
    NAs: cnf.deploy.NAs
  });

  // copy dpm worker.json on the fly
  await writeJson(path.join(cnf.build.dpm.src, './stage/data/cnf/worker.json'), {
    'WorkerDeployCnfPath': '/data/cnf/common/worker/deploy-cnf.json',
    'WorkerMachineCnfPath': '/data/cnf/private/machine/worker.json',
    Workers: cnf.deploy.workers.map(({
      name,
      serviceType,
      dcyTplPath,
      dcyTplConfigPath
    }) => {
      return _.pickBy({
        name,
        ServiceType: serviceType,
        DcyTplPath: dcyTplPath,
        DcyTplConfigPath: dcyTplConfigPath
      }, v => v !== undefined);
    }),
    Machines: cnf.deploy.worker.Machines
  });

  // copy machine/na.json on the fly
  await writeJson(path.join(cnf.build.dpm.src, './stage/data/cnf/private/machine/na.json'),
    cnf.machine.na
  );

  // copy machine/worker.json on the fly
  await writeJson(path.join(cnf.build.dpm.src, './stage/data/cnf/private/machine/worker.json'),
    cnf.machine.na
  );

  // copy id_rsa
  await copyDir(cnf.privateKeyDir,
    path.join(cnf.build.dpm.src, './stage/data/cnf/private/ssh'));

  // copy dpm config.json on the fly
  await writeJson(path.join(cnf.build.dpm.src, './stage/data/config.json'),
    // default dpm config.json
    {
      Only: cnf.only || '',
      RemoteRoot: cnf.deploy.root,

      'OnlineType': 'staging',
      'NAConfPath': '/data/cnf/na.json',
      'WorkerConfPath': '/data/cnf/worker.json',
      'TargetDir': '/data/target',
      'SrcDir': '/data/src'
    }
  );
};

const run = async (cmd, {
  configObject,
  cnfDir,
  only,
  upd
}) => {
  const cnf = await getVespertilioConf({
    only,
    configObject,
    cnfDir
  }, cnfDir);

  switch (cmd) {
    case 'build':
      await build(cnf, {
        upd
      });
      break;
    case 'deploy':
      await deployDpm(cnf.build.dpm['deploy-cnf'], 'staging');
      break;
    case 'run':
      await build(cnf, {
        upd
      });
      await deployDpm(cnf.build.dpm['deploy-cnf'], 'staging');
      break;
    default:
      throw new Error(`unexpected command: ${cmd}`);
  }
};

module.exports = {
  deployDpm,
  getVespertilioConf,
  build,
  run
};
