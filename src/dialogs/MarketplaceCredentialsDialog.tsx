import type { InstalledApp } from "../lib/types";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { EndpointsView } from "../components/marketplace/EndpointsView";

interface MarketplaceCredentialsDialogProps {
  open: boolean;
  app: InstalledApp | null;
  onClose: () => void;
}

/** Installed tab's "Credentials" action: the same Ready-card endpoint view
 * shown right after install, reopened on demand for an already-installed app. */
export function MarketplaceCredentialsDialog({ open, app, onClose }: MarketplaceCredentialsDialogProps) {
  if (!app) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${app.name} credentials`}
      width={520}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <EndpointsView endpoints={app.endpoints} notes={app.notes} />
    </Dialog>
  );
}
