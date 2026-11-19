import type {
    RecallResult,
    RetrievalHit,
    RetrievalQuery,
} from "../core/types.ts";
import { completion } from "../../models/completion/completion.ts";
import { ParallelRecall } from "../recall/parallel.ts";
import type { RetrievalOptions } from "../core/types.ts";
import type { completionOptions } from "../../models/completion/types.ts";
import { deepseekCompletion } from "../../models/completion/deepseek.ts";

const KEYWORD_EXT = `
You are a lexical search query optimizer for BM25 retrieval.

Given a user query, extract a concise keyword query containing only the most discriminative terms needed to retrieve relevant documents.

Rules:
- Preserve important entities, proper nouns, technical terms, and essential constraints.
- Remove question fillers, redundant words, and unnecessary phrases.
- Prefer canonical terms commonly used in academic or technical documents.
- Do not add synonyms, speculative facts, or loosely related concepts.
- Keep the output to 2-6 meaningful terms or short phrases when possible.
- Preserve the original information need.
- Output one search query on a single line, without explanation.

Original query: 

`;

const SYNONYM_ = `
You are a domain-aware synonym expansion assistant for BM25 retrieval.

Given a search query, generate a lexical expansion query that helps retrieve relevant documents using alternative terminology.

Rules:
- Identify the central entities and concepts in the query.
- Preserve the main entities and essential constraints.
- Add useful synonyms, technical equivalents, abbreviations, full forms, and established aliases.
- Prefer terms that relevant documents may use instead of the original wording.
- Only include terms that maintain the same information need.
- Avoid broad topical associations, generic domain words, and speculative relationships.
- Avoid repeating equivalent words unnecessarily.
- Include no more than 8 additional meaningful terms or phrases.
- Output one concise search query on a single line, without explanation.

Original query: 

`

const DOC_ = `
You are generating a hypothetical relevant document passage for BM25 retrieval.

Given a search query, write a short, realistic passage resembling content that might appear in a document relevant to the query.

Rules:
- Write a coherent, informative passage of approximately 60–100 words.
- Address the information need, rather than simply rephrasing the query.
- Include relevant technical terminology, entities, mechanisms, and domain-specific concepts.
- Use natural wording that is likely to occur in actual documents.
- Avoid generic introductions, repeated keywords, and irrelevant background.
- Do not fabricate precise facts, citations, statistics, or uncertain relationships.
- Preserve the original topic and constraints.
- Output only the passage as plain text.

Query: 

`



export function createMultiBM25Options(): RetrievalOptions {
    let llm: completion | undefined;
    const getLLM = (): completion => {
        return llm ??= new deepseekCompletion({});
    };

    return {
        id: "multi_bm25",
        requiresEmbedding: false,
        metadata: {
            recallPaths: ["bm25_original", "bm25_keyphrases", "bm25_synonym", "bm25_document"],
            processor: "rrf",
            score: "Fusioned by rrf",
        },
        createRecall: ({ bm25 }) => new ParallelRecall([
            // original query
            {
                path: "bm25_original",
                run: async (request) => {
                    // console.log(`ori: ${request.query}`);
                    return bm25.retrieve(request);
                }
            },

            // keyphrases: extraction of core entities, keyword, concepts
            {
                path: "bm25_keyphrases",
                run: async (request) => {
                    request.query = await getLLM().getResponse(`${KEYWORD_EXT} ${request.query} `);
                    // console.log(`kp: ${request.query}`);
                    return bm25.retrieve(request);
                }
            },

            // synonym: replacement with abbreviations, synonyms, commonly used words
            {
                path: "bm25_synonym",
                run: async (request) => {
                    request.query = await getLLM().getResponse(`${SYNONYM_} ${request.query}`);
                    // console.log(`sy: ${request.query}`);
                    return bm25.retrieve(request);
                }
            },

            // document-oriented: rewrite the user's query into a search expression that resembles the language and terminology likely to appear in relevant documents
            {
                path: "bm25_document",
                run: async (request) => {
                    request.query = await getLLM().getResponse(`${DOC_} ${request.query} \n\n passage:`);
                    // console.log(`doc: ${request.query}`);
                    return bm25.retrieve(request);
                }
            },

        ]),

        createProcessor: () => ({
            async process(request: RetrievalQuery, results: RecallResult<RetrievalHit>[]): Promise<RetrievalHit[]> {
                if (!Number.isSafeInteger(request.topK) || request.topK < 1) return [];


                // do RRF
                const fused = new Map<
                    string, {
                        hit: RetrievalHit;
                        rrfScore: number, bestRank: number
                    }>();

                for (const { hits } of results) {
                    const seen = new Set<string>();
                    let rank = 0;
                    for (const hit of hits) {
                        const key = JSON.stringify([
                            hit.sourceType,
                            hit.sourceId,
                            hit.sourceType === "document" ? hit.location.chunkIndex : null,
                        ]);

                        if (seen.has(key)) continue;

                        seen.add(key);
                        rank++;
                        const contribution = 1 / (60 + rank);
                        const existing = fused.get(key);

                        if (existing) {
                            existing.rrfScore += contribution;
                            existing.bestRank = Math.min(rank, existing.bestRank);
                        } else {
                            fused.set(key, {
                                hit,
                                rrfScore: contribution,
                                bestRank: rank
                            });
                        }
                    }
                }


                return [...fused.values()]
                    .map(({ hit, rrfScore}) => ({
                        ...hit,
                        score: rrfScore
                    }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, request.topK);

            }
        })
    };
}