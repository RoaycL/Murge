import type { StartupStage, StartupTimingMark, StartupTimelineSnapshot } from '../../shared/diagnostics'

/** One launch's monotonic, credential-free milestones. A stage is recorded once. */
export class StartupTimeline {
  private readonly startedAt: number
  private readonly processStartedAt: string
  private readonly marks: StartupTimingMark[] = []
  private readonly seen = new Set<StartupStage>()
  private sealed = false

  constructor(
    private readonly now: () => number = () => performance.now(),
    wallClock: () => Date = () => new Date(),
    private readonly log: (mark: StartupTimingMark) => void = () => undefined
  ) {
    this.startedAt = now()
    this.processStartedAt = wallClock().toISOString()
  }

  mark(stage: StartupStage): void {
    if (this.sealed || this.seen.has(stage)) return
    this.seen.add(stage)
    const mark = { stage, elapsedMs: Math.max(0, Math.round(this.now() - this.startedAt)) }
    this.marks.push(mark)
    this.log(mark)
  }

  seal(): void {
    this.sealed = true
  }

  snapshot(): StartupTimelineSnapshot {
    return { processStartedAt: this.processStartedAt, marks: this.marks.map((mark) => ({ ...mark })) }
  }
}
