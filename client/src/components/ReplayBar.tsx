import type { PropagateResult } from '../../../shared/graph';

interface ReplayBarProps {
  result: PropagateResult;
  round: number;
  playing: boolean;
  onSeek: (round: number) => void;
  onTogglePlay: () => void;
}

/**
 * 传播回放控制条：拖动滑杆或播放即可回看第 0 轮到停止轮。
 * 纯前端状态切换，不会修改图，也不会触发重新计算或保存。
 */
export function ReplayBar({ result, round, playing, onSeek, onTogglePlay }: ReplayBarProps) {
  const loopable = Boolean(result.oscillating && result.detectedPeriod);
  return (
    <div className="replay-bar">
      <button
        type="button"
        className="replay-toggle"
        onClick={onTogglePlay}
        title={loopable ? `按检测周期 ${result.detectedPeriod} 轮循环播放` : '播放第 0 轮到停止轮'}
      >
        {playing ? '⏸ 暂停' : '▶ 播放'}
      </button>
      <input
        className="replay-slider"
        type="range"
        min={0}
        max={result.iterations}
        step={1}
        value={round}
        aria-label="回放轮次"
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      <span className="replay-round">
        第 {round} / {result.iterations} 轮
      </span>
      {loopable && <span className="replay-loop">周期 {result.detectedPeriod} 循环</span>}
      <span className="replay-note">回放仅切换视图，不改动图</span>
    </div>
  );
}
