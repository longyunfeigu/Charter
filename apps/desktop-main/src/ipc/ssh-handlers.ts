import type { Logger } from '@pi-ide/foundation';
import type { SshService } from '../services/ssh-service.js';
import type { SshSftpService } from '../services/ssh-sftp-service.js';
import type { SshForwardService } from '../services/ssh-forward-service.js';
import type { LocalFilesService } from '../services/local-files-service.js';
import type { RemoteWorkerService } from '../services/remote-worker-service.js';
import { registerHandlers } from './router.js';

/**
 * SSH Remotes IPC surface (ADR-0047). terminal.create's ssh target branch is
 * wired in m4-handlers; everything else lives here. Secrets only appear on the
 * setSecret / respondAuth request payloads (renderer→main).
 */
export function registerSshHandlers(
  ssh: SshService,
  worker: RemoteWorkerService,
  sftp: SshSftpService,
  forwards: SshForwardService,
  localFiles: LocalFilesService,
  logger: Logger,
): void {
  registerHandlers(
    {
      'ssh.listHosts': async () => ({ hosts: ssh.listHosts() }),
      'ssh.saveHost': async ({ host }) => ({ host: ssh.saveHost(host) }),
      'ssh.deleteHost': async ({ hostId }) => {
        forwards.stopHost(hostId);
        await sftp.close(hostId);
        return { deleted: await ssh.deleteHost(hostId) };
      },
      'ssh.connect': async ({ hostId }) => {
        // Fire and forget: progress and outcome stream via the ssh.state event.
        void ssh.connect(hostId).catch(() => logger.warn('ssh connect failed', { hostId }));
        return { started: true };
      },
      'ssh.disconnect': async ({ hostId }) => {
        // Explicit disconnect means "stop using this host" — active forwards
        // and the SFTP channel would silently re-dial it otherwise.
        forwards.stopHost(hostId);
        await sftp.close(hostId);
        return { disconnected: await ssh.disconnect(hostId) };
      },
      'ssh.setSecret': async ({ hostId, kind, value }) => ({
        saved: ssh.setSecret(hostId, kind, value),
      }),
      'ssh.clearSecret': async ({ hostId, kind }) => ({ cleared: ssh.clearSecret(hostId, kind) }),
      'ssh.importConfig': async () => ({ candidates: await ssh.importConfig() }),
      'ssh.applyImport': async ({ hosts }) => ({ added: ssh.applyImport(hosts) }),
      'ssh.probeCli': async ({ hostId, cli }) => ssh.probeCli(hostId, cli),
      'ssh.workerStatus': async ({ hostId }) => ({ worker: await worker.status(hostId) }),
      'ssh.installWorker': async ({ hostId }) => ({ worker: await worker.install(hostId) }),
      'ssh.respondHostKey': async ({ requestId, accept, remember }) => ({
        ok: ssh.respondHostKey(requestId, accept, remember),
      }),
      'ssh.respondAuth': async ({ requestId, answers, save }) => ({
        ok: ssh.respondAuth(requestId, answers, save),
      }),
      // PR2: SFTP file panel.
      'ssh.sftpHome': async ({ hostId }) => ({ path: await sftp.home(hostId) }),
      'ssh.sftpList': async ({ hostId, path }) => sftp.list(hostId, path),
      'ssh.sftpMkdir': async ({ hostId, path }) => {
        await sftp.mkdir(hostId, path);
        return { ok: true };
      },
      'ssh.sftpRename': async ({ hostId, from, to }) => {
        await sftp.rename(hostId, from, to);
        return { ok: true };
      },
      'ssh.sftpDelete': async ({ hostId, path, type }) => {
        await sftp.delete(hostId, path, type);
        return { ok: true };
      },
      'ssh.sftpUpload': async ({ hostId, remoteDir, localPaths }) => ({
        transferIds: await sftp.upload(hostId, remoteDir, localPaths),
      }),
      'ssh.sftpDownload': async ({ hostId, remotePath, name, localDir }) => ({
        transferId: await sftp.download(hostId, remotePath, name, localDir),
      }),
      'ssh.sftpCancel': async ({ transferId }) => ({ ok: sftp.cancel(transferId) }),
      'ssh.sftpRetry': async ({ transferId }) => ({ transferId: sftp.retry(transferId) }),
      // Dual-pane Files panel: local directory metadata (bytes never cross IPC).
      'ssh.localHome': async () => ({ path: localFiles.home() }),
      'ssh.localList': async ({ path }) => localFiles.list(path),
      'ssh.sftpClose': async ({ hostId }) => {
        await sftp.close(hostId);
        return { ok: true };
      },
      // PR3: local port forwards.
      'ssh.saveForward': async ({ hostId, forward }) => ({
        forward: ssh.saveForward(hostId, forward),
      }),
      'ssh.deleteForward': async ({ hostId, forwardId }) => {
        forwards.stop(hostId, forwardId);
        return { deleted: ssh.deleteForward(hostId, forwardId) };
      },
      'ssh.startForward': async ({ hostId, forwardId }) => {
        await forwards.start(hostId, forwardId);
        return { ok: true };
      },
      'ssh.stopForward': async ({ hostId, forwardId }) => ({
        ok: forwards.stop(hostId, forwardId),
      }),
      'ssh.listForwardStates': async () => ({ states: forwards.states() }),
    },
    logger,
  );
}
