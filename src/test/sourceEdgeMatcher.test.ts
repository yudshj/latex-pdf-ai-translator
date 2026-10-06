import assert from 'node:assert/strict'
import test from 'node:test'
import { matchLatexSourceEdges } from '../sourceEdgeMatcher.js'

test('maps a long selection across a generated theorem heading and references', () => {
    const source = String.raw`The uniform-buffer rebinding advances the validation generation and forces revalidation on the next draw. Enabling blending changes the state key, so the next draw runs on another node while $S$ keeps its entries for the frame that returns to it.

\begin{proposition}[Replay soundness]\label{prop:replay}
Replaying a \emph{PreparedDraw} entry $(\sigma \mapsto \tau, X)$ recorded on canonical state node $n$ at validation generation $g$ is observably equivalent to re-deriving it from the current state.
\end{proposition}

Appendix~\ref{app:soundness} proves the proposition. The boundary tests of \rqfour\ check the assumptions behaviorally. To summarize, \emph{PreparedDraw} turns repeated work into a per-node memo. It pays for that memo with explicit invalidation along the state key, the validation generation, and per-artifact content and lifetime guards.`
    const selected = `advances the validation generation and forces revalidation on the next draw. Enabling blending changes the state key, so the next draw runs on another node while S keeps its entries for the frame that returns to it. Proposition 3.1 (Replay soundness). Replaying a PreparedDraw entry recorded on canonical state node n at validation generation g is observably equivalent to re-deriving it from the current state. Appendix A proves the proposition. The boundary tests of RQ4 check the assumptions behaviorally. To summarize, PreparedDraw turns repeated work into a per-node memo. It pays for that memo with explicit invalidation along the state key, the validation generation, and per-artifact content and lifetime guards.`

    const match = matchLatexSourceEdges(source, selected)

    assert.ok(match)
    assert.equal(source.slice(match.startOffset, match.endOffset), String.raw`advances the validation generation and forces revalidation on the next draw. Enabling blending changes the state key, so the next draw runs on another node while $S$ keeps its entries for the frame that returns to it.

\begin{proposition}[Replay soundness]\label{prop:replay}
Replaying a \emph{PreparedDraw} entry $(\sigma \mapsto \tau, X)$ recorded on canonical state node $n$ at validation generation $g$ is observably equivalent to re-deriving it from the current state.
\end{proposition}

Appendix~\ref{app:soundness} proves the proposition. The boundary tests of \rqfour\ check the assumptions behaviorally. To summarize, \emph{PreparedDraw} turns repeated work into a per-node memo. It pays for that memo with explicit invalidation along the state key, the validation generation, and per-artifact content and lifetime guards.`)
})

test('accepts a selection that begins or ends partway through a visible word', () => {
    const source = 'Before. The validation generation changes and then a unique sequence ends with lifetime guards. After.'
    const selected = 'alidation generation changes and then a unique sequence ends with lifetime gua'

    const match = matchLatexSourceEdges(source, selected)

    assert.ok(match)
    assert.equal(source.slice(match.startOffset, match.endOffset), 'validation generation changes and then a unique sequence ends with lifetime guards.')
})

test('does not guess from a short or one-sided edge match', () => {
    assert.equal(matchLatexSourceEdges('A short source selection.', 'short source'), undefined)
    assert.equal(matchLatexSourceEdges(
        'alpha beta gamma delta unique start words followed by unrelated content',
        'alpha beta gamma delta unique start words and a completely different ending phrase here',
    ), undefined)
})
