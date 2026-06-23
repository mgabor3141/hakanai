import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Shown when opening or starting a chat would interrupt another chat that is
// still working. Wording is for non-technical users: the conversation is kept,
// only the in-progress task stops.
export type InterruptPrompt = {
  otherTitle: string;
  action: "switch" | "new";
  onConfirm: () => void;
};

export function InterruptDialog({ prompt, onCancel }: { prompt: InterruptPrompt | null; onCancel: () => void }) {
  const action = prompt?.action ?? "switch";
  const other = prompt?.otherTitle || "Another chat";
  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{action === "new" ? "Start a new chat?" : "Open this chat?"}</DialogTitle>
          <DialogDescription>
            This computer runs a limited number of chats at the same time. "{other}" is still working on something.
            Continuing will stop what it is doing right now. You will not lose that conversation; you can come back to
            it later. Only the task it is running now will be interrupted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Stay here
          </Button>
          <Button onClick={() => prompt?.onConfirm()}>{action === "new" ? "Start anyway" : "Open anyway"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
