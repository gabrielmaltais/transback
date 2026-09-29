const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// Petit client Docker basé sur la CLI `docker` (présente dans l'image) :
// plus simple et plus robuste que l'API HTTP pour `exec` (flux multiplexés).

function docker(args, { timeout = 60000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile('docker', args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: (stderr || '').trim() || (err ? err.message : '') });
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

/** Conteneurs en cours d'exécution : [{ id, name, image }] */
async function listContainers() {
  const r = await docker(['ps', '--no-trunc', '--format', '{{json .}}']);
  if (!r.ok) throw new Error(r.stderr);
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const c = JSON.parse(line);
    return { id: c.ID, name: String(c.Names).split(',')[0], image: c.Image };
  });
}

async function inspect(idOrName) {
  const r = await docker(['inspect', idOrName]);
  if (!r.ok) throw new Error(`docker inspect ${idOrName} : ${r.stderr}`);
  return JSON.parse(r.stdout)[0];
}

function execArgs(container, cmd, user) {
  const args = ['exec'];
  if (user) args.push('--user', user);
  args.push(container, ...cmd);
  return args;
}

function exec(container, cmd, { user, timeout } = {}) {
  return docker(execArgs(container, cmd, user), { timeout });
}

/** Comme exec, mais renvoie le processus pour lire la sortie au fil de l'eau. */
function spawnExec(container, cmd, { user } = {}) {
  return require('child_process').spawn('docker', execArgs(container, cmd, user), { shell: false });
}

/**
 * Identifiant du conteneur dans lequel tourne TransBack.
 * /proc/self/mountinfo contient « /var/lib/docker/containers/<id>/hostname » ;
 * à défaut, le nom d'hôte par défaut de Docker est l'identifiant court.
 */
function selfContainerId(mountinfo) {
  let text = mountinfo;
  if (text === undefined) {
    try { text = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch (_) { text = ''; }
  }
  const m = text.match(/\/containers\/([0-9a-f]{64})\/(?:hostname|resolv\.conf|hosts)/);
  return m ? m[1] : os.hostname();
}

module.exports = { docker, listContainers, inspect, exec, spawnExec, selfContainerId };
