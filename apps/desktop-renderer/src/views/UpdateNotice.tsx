import React from 'react';
import { updateNoticeKey, useAppStore } from '../store/appStore.js';
import { Ic } from './home-icons.js';

export function UpdateNotice(): React.JSX.Element | null {
  const update = useAppStore((state) => state.updateState);
  const dismissedKey = useAppStore((state) => state.dismissedUpdateNoticeKey);
  const dismiss = useAppStore((state) => state.dismissUpdateNotice);
  const openSettings = useAppStore((state) => state.openSettings);
  const openDownload = useAppStore((state) => state.openUpdateDownload);
  const install = useAppStore((state) => state.installUpdate);
  const key = updateNoticeKey(update);

  if (!update || !key || key === dismissedKey || !update.availableVersion) return null;

  const manual = update.delivery === 'manual';
  const version = update.availableVersion;
  const viewUpdates = (): void => {
    dismiss();
    openSettings('updates');
  };

  return (
    <article
      className={`update-notice ${manual ? 'manual' : 'ready'}`}
      data-testid="update-notice"
      aria-label={`Charter ${version} ${manual ? 'available' : 'ready to install'}`}
    >
      <button
        type="button"
        className="update-notice-main"
        data-testid="update-notice-open-settings"
        onClick={viewUpdates}
      >
        <span className="update-notice-icon" aria-hidden="true">
          <Ic name={manual ? 'refresh' : 'checkCircle'} size={17} />
        </span>
        <span className="update-notice-copy">
          <span className="update-notice-kicker">
            {manual ? 'Update available' : 'Ready to install'}
          </span>
          <strong>Charter {version}</strong>
          <small>
            {manual
              ? 'Open the verified GitHub Release to download this preview.'
              : 'The signed update is downloaded. Restart when your work is at a safe stopping point.'}
          </small>
        </span>
      </button>

      <button
        type="button"
        className="update-notice-close"
        data-testid="update-notice-close"
        aria-label="Dismiss update notification"
        onClick={dismiss}
      >
        <Ic name="x" size={12} />
      </button>

      <div className="update-notice-actions">
        {manual ? (
          <button
            type="button"
            className="update-notice-action primary"
            data-testid="update-notice-download"
            onClick={() => void openDownload()}
          >
            View &amp; download
          </button>
        ) : (
          <>
            <button
              type="button"
              className="update-notice-action"
              data-testid="update-notice-later"
              onClick={dismiss}
            >
              Later
            </button>
            <button
              type="button"
              className="update-notice-action primary"
              data-testid="update-notice-install"
              onClick={() => void install()}
            >
              Restart &amp; install
            </button>
          </>
        )}
      </div>
    </article>
  );
}
