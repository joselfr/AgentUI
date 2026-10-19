// Two-way widget used by e2e/ui-twoway.mjs: a tic-tac-toe board that stays in the same component while the agent plays.
// The user's clicks go to the agent with reply(…, { silent: true }); the agent answers by pushing a new `state` (agentui_custom_widget `update`).
export const GAME_CODE = `import { useState } from 'react';
import { Button, Card, Row, Stack, Text, reply, useAgentState, useCanReply, useWidth } from '@agentui/ui';

export default function Game() {
  const state = useAgentState({ cells: Array(9).fill(''), note: 'Your turn (X)' });
  const canReply = useCanReply();
  const width = useWidth();
  const [clicks, setClicks] = useState(0); // local state: kept when the agent pushes a new state
  return (
    <Card>
      <Stack gap={1}>
        <Text variant="subtitle">{state.note}</Text>
        {[0, 1, 2].map((r) => (
          <Row key={r} gap={1}>
            {[0, 1, 2].map((c) => {
              const i = r * 3 + c;
              return <Button key={i} variant="outlined" disabled={!canReply || !!state.cells[i]} onClick={() => { setClicks((n) => n + 1); reply('move ' + i, { silent: true }); }}>{state.cells[i] || '·'}</Button>;
            })}
          </Row>
        ))}
        <Text variant="caption" muted>Clicks: {clicks}</Text>
        <Text variant="caption" muted>Width: {width}</Text>
      </Stack>
    </Card>
  );
}
`;
export const newGame = () => ({ cells: Array(9).fill(''), note: 'Your turn (X)' });
