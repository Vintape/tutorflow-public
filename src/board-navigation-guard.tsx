import { useBlocker } from 'react-router-dom';
import { Button, Modal } from './components';

let confirmedBoardExit: string | undefined;
/** Only the immediate, explicitly confirmed copy/delete transition may bypass the guard. */
export function leaveConfirmedBoard(boardId: string, navigate: () => void): void {
  const previous = confirmedBoardExit;
  confirmedBoardExit = boardId;
  try {
    navigate();
  } finally {
    confirmedBoardExit = previous;
  }
}

/** POP navigation does not fire beforeunload; keep the live editor mounted until a decision. */
export function BoardNavigationGuard({ boardId }: { boardId: string }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (confirmedBoardExit === boardId) return false;
    if (
      currentLocation.pathname === nextLocation.pathname &&
      currentLocation.search === nextLocation.search
    )
      return false;
    return Boolean(document.querySelector('[data-testid="board-editor"][data-dirty="true"]'));
  });
  return blocker.state === 'blocked' ? (
    <Modal
      open
      onClose={() => blocker.reset()}
      title="Есть несохранённые изменения"
      description="Сохраните черновики перед выходом с доски."
    >
      <p>
        На доске есть черновики или изменения, запись которых ещё не подтверждена. Останьтесь на
        доске и сохраните файл восстановления перед выходом.
      </p>
      <div className="board-actions">
        <Button variant="secondary" onClick={() => blocker.reset()}>
          Остаться на доске
        </Button>
        <Button variant="danger" onClick={() => blocker.proceed()}>
          Выйти без сохранения
        </Button>
      </div>
    </Modal>
  ) : null;
}
