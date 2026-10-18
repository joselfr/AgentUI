import { Box } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/** Compact Markdown text for widget texts (question, detail): same extensions as messages, without surrounding margins. */
export default function Markdown({ children }: { children: string }) {
  return (
    <Box sx={{
      overflowWrap: 'anywhere', '& > :first-of-type': { mt: 0 }, '& > :last-child': { mb: 0 },
      '& p': { my: 0.5 }, '& ul, & ol': { my: 0.5, pl: 2.5 }, '& a': { color: 'primary.main' },
      '& :not(pre) > code': { px: 0.6, py: 0.15, borderRadius: 1, bgcolor: 'action.selected', fontSize: '0.88em' },
    }}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ a: ({ node: _n, ...a }) => <a {...a} target="_blank" rel="noreferrer" /> }}>{children}</ReactMarkdown>
    </Box>
  );
}
