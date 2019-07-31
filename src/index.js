const path = require('path');
const del = require('del');
const {
  spawnp,
  exec,
  readConfig,
  existsDir,
  mkdirp,
  parseTpl
} = require('flexdeploy/src/util');
const {
  copyDir,
  writeJson
} = require('./util');

const deployDpm = async (dpmDeployCnfPath, onlineType) => {
  await spawnp(
    // '../node_modules/.bin/ideploy',
    '../../insight-in-one/thirdparty/flexdeploy/bin/ideploy',

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

const getVespertilioConf = async (argv) => {
  const cnfFilePath = path.resolve(process.cwd(), argv.config || 'vespertilio.json');
  const cnf = Object.assign(await readConfig(cnfFilePath), {
    only: argv.only
  });

  const cnfDir = path.dirname(cnfFilePath);

  cnf.cwd = cnfDir;

  const baseDir = `./clusters/${cnf.name}`;

  // merge with default configuration options
  cnf.dpm = Object.assign({
    'deploy-cnf': `${baseDir}/dpm/deploy-cnf.json`,
    'src': `${baseDir}/dpm/src`,
    'cnfDir': `${baseDir}/conf/dpm/cnf`,
    'cnfFile': `${baseDir}/conf/dpm/config.json`,
    'data': `${baseDir}/conf/data`
  }, cnf.dpm || {});

  cnf.httpna = Object.assign({
    'cnfDir': `${baseDir}/conf/http_na`
  }, cnf.httpna || {});

  cnf.source = Object.assign({
    'repoRoot': `${baseDir}/code_repo`,
  }, cnf.source || {});

  // resolve paths
  cnf.source.repoRoot = path.resolve(cnfDir, cnf.source.repoRoot);

  cnf.dpm.cnfDir = path.join(cnfDir, cnf.dpm.cnfDir);
  cnf.dpm.cnfFile = path.join(cnfDir, cnf.dpm.cnfFile);
  cnf.dpm.src = path.resolve(cnfDir, cnf.dpm.src);
  cnf.dpm['deploy-cnf'] = path.resolve(cnfDir, cnf.dpm['deploy-cnf']);
  cnf.httpna.cnfDir = path.join(cnfDir, cnf.httpna.cnfDir);

  cnf.privateKeyDir = path.resolve(cnfDir, cnf.privateKeyDir);

  return cnf;
};

const syncBaseProjects = async (cnf, argv) => {
  // if need to force update demo project,
  if (!await existsDir(cnf.dpm.src) || argv.upd) {
    await del([cnf.dpm.src]);
    await spawnp('git', ['clone', 'git@github.com:lock-free/dpm-cluster-demo.git', cnf.dpm.src]);
    await del([path.join(cnf.dpm.src, '.git')]);
  }

  await Promise.all([
    updateRepo('git@github.com:lock-free/dpm_service.git', cnf.source.repoRoot, 'dpm_service'),
    updateRepo('git@github.com:lock-free/na_service.git', cnf.source.repoRoot, 'na_service'),
    updateRepo('git@github.com:lock-free/httpna_service.git', cnf.source.repoRoot, 'httpna_service')
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
const copyStageToDpmSrcRepo = async (repoRoot, srcRepo, targetDir) => {
  const srcStage = path.resolve(srcRepo, targetDir, 'stage');
  const repoStage = path.resolve(repoRoot, targetDir, 'stage');

  await copyDir(repoStage, srcStage);
  await spawnp('cp', [path.join(__dirname, '../res/makefile'), path.resolve(srcRepo, targetDir, 'makefile')]);
};

const getWorkers = (cnf) => {
  return (
    cnf.only ? cnf.source.workers.filter(({
      serviceType
    }) => serviceType === cnf.only) : cnf.source.workers
  );
};

// copy projects to dpm source dir
const buildDpm = async (cnf) => {
  // copy binary
  const dpmBinPath = path.resolve(cnf.dpm.src, './stage/bin/');
  await mkdirp(dpmBinPath);
  await spawnp('cp', [path.resolve(cnf.source.repoRoot, 'dpm_service/stage/bin/dpm_service'), dpmBinPath]);

  // copy deploy-cnf.json to dpm dir
  await writeJson(cnf.dpm['deploy-cnf'],
    Object.assign({
      'project': cnf.name || 'vespertilio-cluster',

      'srcDir': './src',
      'stageDir': 'stage',
      'depDir': './src',

      'hooks': {
        'pre': [],
        'afterDeployRemoteCmds': []
      }
    }, cnf.dpm.deploy)
  );
};

const build = async (cnf, argv) => {
  // sync base projects: dpm-cluster-demo, dpm_service, na_service, httpna_service
  await syncBaseProjects(cnf, argv);

  await copySourceCodeToDpmSrc(cnf);

  const srcRepo = path.resolve(cnf.dpm.src, './stage/data/src');

  await Promise.all([
    await copyDpmData(cnf),
    // copy config for httpna
    await copyDir(cnf.httpna.cnfDir, path.join(cnf.dpm.src, './stage/data/src/httpna_service/stage/data')),
  ].concat(
    // copy workers data
    getWorkers(cnf).map(async ({
      serviceType
    }) => {
      // copy data dir
      if (cnf.dpm.data) {
        const workerDataSrcDir = path.join(cnf.cwd, cnf.dpm.data, serviceType);
        const workerDataTarDir = path.join(srcRepo, serviceType, './stage/data');
        if (await existsDir(workerDataSrcDir)) {
          await copyDir(workerDataSrcDir, workerDataTarDir);
        }
      }
    })
  ));

  await buildDpm(cnf);
};

// copy code to dpm src dir
const copySourceCodeToDpmSrc = async (cnf) => {
  const srcRepo = path.resolve(cnf.dpm.src, './stage/data/src');

  await Promise.all([
    // copy basic services
    await copyStageToDpmSrcRepo(cnf.source.repoRoot, srcRepo, 'na_service'),
    await copyStageToDpmSrcRepo(cnf.source.repoRoot, srcRepo, 'httpna_service')
  ].concat(
    // copy workers
    getWorkers(cnf).map(async ({
      serviceType,
      buildCmd
    }) => {
      // build first
      if (buildCmd) {
        await exec(parseTpl(buildCmd, cnf), {
          cwd: cnf.cwd
        });
      }
      // copy source from repo root to dpm src repo
      await copyStageToDpmSrcRepo(cnf.source.repoRoot, srcRepo, serviceType);
    })));
};

const copyDpmData = async (cnf) => {
  // copy common dir
  if (await existsDir(path.join(cnf.dpm.cnfDir, 'common'))) {
    await copyDir(path.join(cnf.dpm.cnfDir, 'common'), path.join(cnf.dpm.src, './stage/data/cnf/common'));
  }

  // copy private dir
  if (await existsDir(path.join(cnf.dpm.cnfDir, 'private'))) {
    await copyDir(path.join(cnf.dpm.cnfDir, 'private'), path.join(cnf.dpm.src, './stage/data/cnf/private'));
  }

  // copy dpm cnf na.json on the fly
  await writeJson(path.join(cnf.dpm.src, './stage/data/cnf/na.json'), {
    'NADeployCnfPath': '/data/cnf/common/na/deploy-cnf.json',
    'NAMachineCnfPath': '/data/cnf/private/machine/na.json',
    NAs: cnf.remote.NAs
  });

  // copy dpm worker.json on the fly
  await writeJson(path.join(cnf.dpm.src, './stage/data/cnf/worker.json'), {
    'WorkerDeployCnfPath': '/data/cnf/common/worker/deploy-cnf.json',
    'WorkerMachineCnfPath': '/data/cnf/private/machine/worker.json',
    Workers: cnf.remote.worker.Workers,
    Machines: cnf.remote.worker.Machines
  });

  // copy machine/na.json on the fly
  await writeJson(path.join(cnf.dpm.src, './stage/data/cnf/private/machine/na.json'),
    cnf.machine.na
  );

  // copy machine/worker.json on the fly
  await writeJson(path.join(cnf.dpm.src, './stage/data/cnf/private/machine/worker.json'),
    cnf.machine.na
  );

  // copy id_rsa
  await copyDir(cnf.privateKeyDir,
    path.join(cnf.dpm.src, './stage/data/cnf/private/ssh'));

  // copy dpm config.json on the fly
  await writeJson(path.join(cnf.dpm.src, './stage/data/config.json'),
    // default dpm config.json
    {
      Only: cnf.only || '',
      RemoteRoot: cnf.remote.root,

      'OnlineType': 'staging',
      'NAConfPath': '/data/cnf/na.json',
      'WorkerConfPath': '/data/cnf/worker.json',
      'TargetDir': '/data/target',
      'SrcDir': '/data/src'
    }
  );
};

module.exports = {
  deployDpm,
  getVespertilioConf,
  build
};
