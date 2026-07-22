export class TerminalUserInputTracker {
  private armed = false;
  private expiry: ReturnType<typeof setTimeout> | null = null;

  mark(): void {
    this.armed = true;
    if (this.expiry) clearTimeout(this.expiry);
    // IME commits can emit terminal data on the next task rather than synchronously.
    this.expiry = setTimeout(() => {
      this.armed = false;
      this.expiry = null;
    }, 250);
  }

  consume(): boolean {
    const userInitiated = this.armed;
    this.armed = false;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    return userInitiated;
  }
}
