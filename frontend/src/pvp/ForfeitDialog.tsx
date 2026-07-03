// Shared destructive-confirm for leaving a live arena match. Leaving forfeits: the opponent takes the
// pot and the player's stake is gone. Copy is fixed (see Global Constraints). Every arena game routes
// its in-match Back through this instead of a bare leave/settle.
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function ForfeitDialog({
  open,
  stake,
  onKeepPlaying,
  onForfeit,
}: {
  open: boolean;
  /** Preformatted per-seat stake, e.g. "100 MTPS". */
  stake: string;
  onKeepPlaying: () => void;
  onForfeit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onKeepPlaying()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Forfeit this match?</DialogTitle>
          <DialogDescription>
            Leaving now forfeits the game — your opponent takes the pot and your{" "}
            {stake} stake is gone. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" autoFocus onClick={onKeepPlaying}>
            Keep playing
          </Button>
          <Button variant="destructive" onClick={onForfeit}>
            Forfeit &amp; leave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
