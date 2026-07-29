import type { ConferenceProfile, FormatRules, TemplateSpec } from '../types'

/**
 * Seed corpus of venue baselines.
 *
 * Why this exists: /api/execute is specified to accept nothing but
 * `{ "prompt": "..." }`. Without a warm knowledge base the first request for
 * any venue can only return the human-in-the-loop confirmation question, so a
 * reviewer POSTing a single prompt would never see the agent do real work. The
 * seeds make the common venues a cache hit on the very first call; the
 * human-in-the-loop ingestion path still runs for anything not seeded.
 *
 * These are baselines drawn from recent editions of each venue and are stamped
 * `source: "seed"` with `as_of`. Every profile built from a seed says so, and
 * the format report tells the user to confirm against the current CFP.
 */

/**
 * Version stamp for the built-in baselines. Bump this whenever a seed's facts
 * change: profiles derived from a seed carry it in `updated_at`, and the
 * profiler treats any cached seed profile with a different stamp as a miss, so
 * a correction reaches every venue instead of being masked by the cache.
 */
export const SEED_AS_OF = '2026-07-29c'

interface VenueSeed {
  family: string
  display: string
  aliases: string[]
  cfp_url: string
  /**
   * Author guide / formatting instructions. This is where the concrete rules
   * actually live — a bare call-for-papers is mostly topics and dates — so it
   * is the page the profiler prefers to read.
   */
  guide_url: string
  focus_areas: string[]
  valued_criteria: string[]
  accepted_paper_emphasis: string[]
  rules: FormatRules
  /** Short CFP-style passages indexed into the vector store for this venue. */
  corpus: string[]
}

const numeric = 'numeric' as const
const authorYear = 'author-year' as const

/**
 * Machine-checkable template facts, filled in only for venues whose template we
 * have actually read. Guessing a style-package name would produce a confident
 * "your preamble is wrong" against a package that does not exist, so the rest
 * stay null and their preamble checks simply do not run until the profiler
 * ingests the venue's author guide.
 */
const NO_TEMPLATE_SPEC: TemplateSpec | null = null

export const VENUE_SEEDS: VenueSeed[] = [
  {
    family: 'iclr',
    display: 'ICLR',
    aliases: ['iclr', 'international conference on learning representations'],
    cfp_url: 'https://iclr.cc/Conferences/2026/CallForPapers',
    guide_url: 'https://iclr.cc/Conferences/2026/AuthorGuide',
    focus_areas: [
      'representation learning',
      'deep learning architectures and optimisation',
      'generative models',
      'large language models and reasoning',
      'theory of deep learning',
    ],
    valued_criteria: [
      'a clear conceptual or methodological contribution to representation learning',
      'careful, reproducible empirical evidence with ablations',
      'insight into *why* a method works, not only that it works',
      'open reproducibility (code, reproducibility statement)',
    ],
    accepted_paper_emphasis: [
      'framing the contribution as a general learning principle rather than a domain application',
      'ablations that isolate the mechanism responsible for the gain',
      'comparison against strong, recent baselines under a matched budget',
      'explicit limitations and negative results',
    ],
    rules: {
      page_limit: 9,
      references_in_limit: false,
      abstract_word_limit: null,
      abstract_single_paragraph: true,
      anonymous: true,
      citation_style: authorYear,
      // Verified against iclr2026.zip: iclr2026_conference.sty \RequirePackage{natbib},
      // the shell .tex uses \bibliographystyle{iclr2026_conference}, and the
      // instructions forbid modifying the text rectangle. \iclrfinalcopy switches
      // the style to camera-ready, which de-anonymises the paper.
      template_spec: {
        style_package: 'iclr2026_conference',
        bibliography_style: 'iclr2026_conference',
        deanonymising_options: [],
        forbidden_macros: ['\\iclrfinalcopy'],
        forbids_layout_override: true,
        template_url: 'https://github.com/ICLR/Master-Template/raw/master/iclr2026.zip',
      },
      template: 'the official ICLR template (iclr2026.zip → iclr2026_conference.sty + .bst, natbib author–year, single column)',
      // The 2026 Author Guide calls the Reproducibility Statement "strongly
      // encouraged" and the Ethics Statement "optional"; neither is mandatory,
      // so neither may be reported as a failure.
      required_sections: [],
      recommended_sections: ['Reproducibility Statement', 'Ethics Statement'],
      unresolved: [],
    },
    corpus: [
      'ICLR 2026 submissions are limited to 9 pages of main text. The camera-ready version may use 10 pages. The bibliography does not count toward the page limit, and authors may add as many appendix pages after the bibliography as they wish, though reviewers are not obliged to read them.',
      'ICLR review is double blind: reviewers cannot see author names and authors cannot see reviewer names. A paper whose author identity is revealed in either the main text or the supplementary material will be desk rejected.',
      'ICLR requires the official template, distributed as iclr2026.zip from the ICLR Master-Template repository. It provides iclr2026_conference.sty and iclr2026_conference.bst, loads natbib, and is used with \\bibliographystyle{iclr2026_conference}. Citations are author–year via \\citet and \\citep. Do not modify margins, font size or spacing.',
      'An Ethics Statement is optional at ICLR but encouraged where relevant; it does not count toward the page limit and should not exceed one page. A paragraph-long Reproducibility Statement is strongly encouraged and also does not count toward the page limit.',
      'If large language models played a significant role in research ideation or writing, ICLR requires the authors to disclose it. The disclosure may appear in the appendix and does not count toward the page limit.',
      'ICLR does not permit dual submission: papers identical or substantially similar to work previously published or accepted elsewhere are not allowed. Preprints on non-peer-reviewed servers such as arXiv do not violate this policy.',
      'ICLR body text must be confined to a rectangle 5.5 inches wide and 9 inches long, set in 10 point type with 11 point vertical spacing, starting 1 inch from the top of the page. Times New Roman is the preferred typeface. Do not modify the width or length of that rectangle and do not change font sizes. Pages must be numbered.',
      'The ICLR paper title is 17 point, small caps, left-aligned. First-level headings are small caps, flush left, 12 point; second- and third-level headings are small caps, flush left, 10 point. The word "Abstract" is centered, small caps, 12 point, and the abstract paragraph is indented half an inch on both margins.',
      'The ICLR abstract must be limited to one paragraph.',
      'ICLR citations use natbib. Use \\citet when the authors or the publication are part of the sentence ("Smith et al. (2020) show that..."), and \\citep otherwise ("...as shown previously (Smith et al., 2020)"). A bare \\cite renders as a number and is not the ICLR style.',
      'Once an ICLR paper is accepted, insert \\iclrfinalcopy to switch the style file to camera-ready formatting, which de-anonymises the paper and expands the main-text limit to 10 pages.',
      'ICLR values contributions to representation learning: new architectures, training objectives, optimisation insights, theory, and empirical studies that explain why methods behave as they do.',
    ],
  },
  {
    family: 'neurips',
    display: 'NeurIPS',
    aliases: ['neurips', 'nips', 'neural information processing systems'],
    cfp_url: 'https://neurips.cc/Conferences/2026/CallForPapers',
    guide_url: 'https://neurips.cc/Conferences/2026/AuthorGuidelines',
    focus_areas: [
      'machine learning theory and algorithms',
      'deep learning',
      'probabilistic methods and statistics',
      'neuroscience and cognitive science links',
      'datasets and benchmarks (separate track)',
    ],
    valued_criteria: [
      'technical novelty backed by either theory or rigorous experiments',
      'broad significance to the machine learning community',
      'honest reporting: error bars, compute budget, failure modes',
      'a completed NeurIPS paper checklist',
    ],
    accepted_paper_emphasis: [
      'a crisp claim stated early and then defended, rather than a system description',
      'theoretical grounding or a controlled empirical study isolating the effect',
      'statistical rigour — multiple seeds, confidence intervals',
      'a broader-impact discussion that is specific rather than boilerplate',
    ],
    rules: {
      page_limit: 9,
      references_in_limit: false,
      abstract_word_limit: null,
      abstract_single_paragraph: null,
      anonymous: true,
      citation_style: authorYear,
      // Verified against neurips_2026.sty: the default (main-track) option is
      // anonymous, while \if@neuripsfinal and \if@preprint both set
      // \@anonymousfalse — so [final] and [preprint] print the author names.
      template_spec: {
        style_package: 'neurips_2026',
        bibliography_style: null,
        deanonymising_options: ['final', 'preprint'],
        forbidden_macros: [],
        forbids_layout_override: true,
        template_url: 'https://neurips.cc/Conferences/2026/AuthorGuidelines',
      },
      template: 'the official NeurIPS LaTeX style (neurips_2026.sty)',
      required_sections: ['Limitations'],
      recommended_sections: [],
      unresolved: [],
    },
    corpus: [
      'NeurIPS main-track submissions are limited to 9 content pages. References, the checklist and the appendix do not count toward this limit.',
      'NeurIPS review is double-blind. Submissions must not contain author names or affiliations, and must avoid self-identifying references such as "in our previous work [12]".',
      'NeurIPS requires every submission to complete the paper checklist, which asks authors to state limitations, compute resources, and whether error bars are reported.',
      'NeurIPS uses the official style file with author–year citations. Papers must report the compute used and include error bars or multiple random seeds where feasible.',
      'NeurIPS accepts work across theory, algorithms, deep learning, probabilistic methods, and applications, and runs a separate Datasets and Benchmarks track.',
    ],
  },
  {
    family: 'icml',
    display: 'ICML',
    aliases: ['icml', 'international conference on machine learning'],
    cfp_url: 'https://icml.cc/Conferences/2026/CallForPapers',
    guide_url: 'https://icml.cc/Conferences/2026/AuthorInstructions',
    focus_areas: [
      'machine learning algorithms and theory',
      'optimisation',
      'deep learning',
      'reinforcement learning',
      'trustworthy and efficient ML',
    ],
    valued_criteria: [
      'methodological rigour and clarity of the claim',
      'theoretical analysis or a decisive empirical comparison',
      'reproducibility of the reported results',
      'positioning against the closest prior work',
    ],
    accepted_paper_emphasis: [
      'a well-scoped algorithmic contribution with analysis',
      'experiments designed to test a hypothesis, not to showcase a system',
      'careful hyper-parameter and compute matching against baselines',
    ],
    rules: {
      page_limit: 8,
      references_in_limit: false,
      abstract_word_limit: null,
      abstract_single_paragraph: null,
      anonymous: true,
      citation_style: authorYear,
      template_spec: NO_TEMPLATE_SPEC,
      template: 'the official ICML LaTeX style (icml2026.sty)',
      required_sections: [],
      recommended_sections: [],
      unresolved: [],
    },
    corpus: [
      'ICML submissions are limited to 8 pages of main content, with unlimited pages for references and appendices.',
      'ICML review is double-blind; submissions must be anonymised, including acknowledgements and identifying links.',
      'ICML uses its official LaTeX style with author–year citations. Reviewers expect a clear statement of the contribution in the abstract and introduction.',
      'ICML values algorithmic and theoretical contributions to machine learning, with rigorous empirical validation against strong baselines.',
    ],
  },
  {
    family: 'acl',
    display: 'ACL',
    aliases: ['acl', 'association for computational linguistics', 'acl rolling review', 'arr'],
    cfp_url: 'https://www.aclweb.org/portal/',
    guide_url: 'https://acl-org.github.io/ACLPUB/formatting.html',
    focus_areas: [
      'natural language processing',
      'large language models and evaluation',
      'multilinguality and low-resource languages',
      'interpretability of language models',
      'NLP applications and resources',
    ],
    valued_criteria: [
      'a well-motivated NLP problem with a sound experimental design',
      'linguistic or empirical insight beyond a leaderboard number',
      'responsible NLP: data provenance, annotation quality, ethical considerations',
      'reproducibility checklist completion',
    ],
    accepted_paper_emphasis: [
      'clear task definition and honest error analysis',
      'evaluation across more than one dataset or language where feasible',
      'a Limitations section that engages seriously with the weaknesses',
    ],
    rules: {
      page_limit: 8,
      references_in_limit: false,
      abstract_word_limit: null,
      abstract_single_paragraph: null,
      anonymous: true,
      citation_style: authorYear,
      template_spec: NO_TEMPLATE_SPEC,
      template: 'the ACL style files (acl.sty, natbib author–year)',
      required_sections: ['Limitations'],
      recommended_sections: [],
      unresolved: [],
    },
    corpus: [
      'ACL long papers may be up to 8 pages of content; short papers up to 4 pages. References, the mandatory Limitations section, and appendices do not count toward the limit.',
      'ACL requires an unnumbered Limitations section after the conclusion. Papers without it may be desk-rejected.',
      'Submissions to ACL Rolling Review are anonymous: no author names, no affiliations, no acknowledgements, and no de-anonymising links.',
      'ACL uses the official style files with author–year citations via natbib (\\citet, \\citep).',
      'ACL values contributions to computational linguistics and NLP, including resources, evaluation, interpretability, multilinguality, and applications.',
    ],
  },
  {
    family: 'emnlp',
    display: 'EMNLP',
    aliases: ['emnlp', 'empirical methods in natural language processing'],
    cfp_url: 'https://www.aclweb.org/portal/',
    guide_url: 'https://acl-org.github.io/ACLPUB/formatting.html',
    focus_areas: [
      'empirical NLP methods',
      'language model behaviour and analysis',
      'information extraction and question answering',
      'evaluation and benchmarking',
    ],
    valued_criteria: [
      'strong empirical methodology and reproducibility',
      'analysis that explains the result, not only the metric',
      'responsible data and annotation practice',
    ],
    accepted_paper_emphasis: [
      'empirical depth: multiple datasets, ablations, error analysis',
      'clarity about what the experiment does and does not show',
      'a substantive Limitations section',
    ],
    rules: {
      page_limit: 8,
      references_in_limit: false,
      abstract_word_limit: null,
      abstract_single_paragraph: null,
      anonymous: true,
      citation_style: authorYear,
      template_spec: NO_TEMPLATE_SPEC,
      template: 'the ACL style files (acl.sty, natbib author–year)',
      required_sections: ['Limitations'],
      recommended_sections: [],
      unresolved: [],
    },
    corpus: [
      'EMNLP long papers are limited to 8 pages of content, excluding references, the Limitations section, and appendices.',
      'EMNLP requires an unnumbered Limitations section; omitting it can lead to desk rejection.',
      'EMNLP submissions are anonymous and must not contain author names, affiliations, acknowledgements, or identifying links.',
      'EMNLP emphasises empirical rigour: careful experimental design, error analysis, and honest reporting of negative results.',
    ],
  },
  {
    family: 'cvpr',
    display: 'CVPR',
    aliases: ['cvpr', 'computer vision and pattern recognition', 'iccv', 'eccv'],
    cfp_url: 'https://cvpr.thecvf.com/Conferences/2026/AuthorGuidelines',
    guide_url: 'https://cvpr.thecvf.com/Conferences/2026/AuthorGuidelines',
    focus_areas: [
      'computer vision',
      'visual recognition and detection',
      'generative vision models',
      '3D vision and reconstruction',
      'vision-language models',
    ],
    valued_criteria: [
      'state-of-the-art or otherwise decisive quantitative results',
      'thorough benchmarking on standard vision datasets',
      'qualitative results and failure cases',
      'clear architecture and training details for reproduction',
    ],
    accepted_paper_emphasis: [
      'benchmark tables against the current best published numbers',
      'ablation studies over every added component',
      'figures that carry the explanation, not just decorate it',
    ],
    rules: {
      page_limit: 8,
      references_in_limit: false,
      abstract_word_limit: null,
      abstract_single_paragraph: null,
      anonymous: true,
      citation_style: numeric,
      template_spec: NO_TEMPLATE_SPEC,
      template: 'the official CVPR LaTeX template (cvpr.sty)',
      required_sections: [],
      recommended_sections: [],
      unresolved: [],
    },
    corpus: [
      'CVPR submissions are limited to 8 pages, excluding references. Papers exceeding the limit are rejected without review.',
      'CVPR review is double-blind. Do not include author names, affiliations, acknowledgements, or links that reveal identity. Refer to your own prior work in the third person.',
      'CVPR uses numeric citations in square brackets with the official template. Do not alter the template.',
      'CVPR expects quantitative comparison on standard benchmarks, ablation studies, and qualitative results including failure cases.',
    ],
  },
  {
    family: 'aaai',
    display: 'AAAI',
    aliases: ['aaai', 'association for the advancement of artificial intelligence'],
    cfp_url: 'https://aaai.org/conference/aaai/',
    guide_url: 'https://aaai.org/authorkit/',
    focus_areas: [
      'artificial intelligence broadly',
      'knowledge representation and reasoning',
      'planning and search',
      'machine learning',
      'AI for social impact',
    ],
    valued_criteria: [
      'significance to AI beyond a single sub-community',
      'technical soundness and clear evaluation',
      'reproducibility checklist completion',
    ],
    accepted_paper_emphasis: [
      'framing the work as an AI contribution rather than a narrow ML result',
      'clear problem formalisation',
      'evaluation appropriate to the sub-area (benchmarks, proofs, or user studies)',
    ],
    rules: {
      page_limit: 7,
      references_in_limit: false,
      abstract_word_limit: null,
      abstract_single_paragraph: null,
      anonymous: true,
      citation_style: authorYear,
      template_spec: NO_TEMPLATE_SPEC,
      template: 'the AAAI author kit (aaai.sty, AAAI press format)',
      required_sections: [],
      recommended_sections: [],
      unresolved: [],
    },
    corpus: [
      'AAAI technical track papers are limited to 7 pages of content plus up to 2 pages of references.',
      'AAAI review is double-blind; submissions must be anonymised.',
      'AAAI requires the AAAI Press author kit and its formatting; papers that violate the format are rejected without review.',
      'AAAI covers the breadth of artificial intelligence: reasoning, planning, knowledge representation, machine learning, multi-agent systems, and AI for social impact.',
    ],
  },
  {
    family: 'kdd',
    display: 'KDD',
    aliases: ['kdd', 'sigkdd', 'knowledge discovery and data mining'],
    cfp_url: 'https://kdd.org/',
    guide_url: 'https://kdd.org/kdd2026/calls/view/kdd-2026-call-for-research-track-papers',
    focus_areas: [
      'data mining and knowledge discovery',
      'large-scale machine learning systems',
      'graph and network mining',
      'applied data science',
    ],
    valued_criteria: [
      'demonstrated impact on a real problem or at real scale',
      'rigorous evaluation on real datasets',
      'deployment lessons and system detail (applied track)',
    ],
    accepted_paper_emphasis: [
      'quantified real-world or production impact',
      'scalability analysis, not only accuracy',
      'a clear distinction between the research and applied data science tracks',
    ],
    rules: {
      page_limit: 9,
      references_in_limit: false,
      abstract_word_limit: null,
      abstract_single_paragraph: null,
      anonymous: true,
      citation_style: numeric,
      template_spec: NO_TEMPLATE_SPEC,
      template: 'the ACM sigconf template (acmart, sigconf)',
      required_sections: [],
      recommended_sections: [],
      unresolved: [],
    },
    corpus: [
      'KDD research track papers are limited to 9 pages plus unlimited references, using the ACM sigconf template.',
      'KDD review is double-blind for the research track; anonymise author names, affiliations, and acknowledgements.',
      'KDD uses the ACM acmart template with numeric citations.',
      'KDD values work with demonstrable impact on real data at scale, and runs a separate applied data science track for deployed systems.',
    ],
  },
]

/** Canonical id + display name for a user-supplied venue string. */
export interface ResolvedVenue {
  venue_id: string
  display: string
  family: string | null
  year: string | null
}

export function resolveVenue(input: string): ResolvedVenue {
  const raw = input.trim().replace(/\s+/g, ' ')
  const lower = raw.toLowerCase()
  const year = lower.match(/\b(20\d{2})\b/)?.[1] ?? null

  const seed = VENUE_SEEDS.find((v) =>
    v.aliases.some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)),
  )

  if (seed) {
    return {
      venue_id: year ? `${seed.family}-${year}` : seed.family,
      display: year ? `${seed.display} ${year}` : seed.display,
      family: seed.family,
      year,
    }
  }

  const slug =
    lower
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'unknown-venue'
  return { venue_id: slug, display: raw || 'the target venue', family: null, year }
}

export function seedFor(family: string | null): VenueSeed | null {
  if (!family) return null
  return VENUE_SEEDS.find((v) => v.family === family) ?? null
}

/** Builds a ConferenceProfile from a seed, stamped so its provenance is visible. */
export function profileFromSeed(resolved: ResolvedVenue): ConferenceProfile | null {
  const seed = seedFor(resolved.family)
  if (!seed) return null
  return {
    venue_id: resolved.venue_id,
    venue: resolved.display,
    focus_areas: seed.focus_areas,
    valued_criteria: seed.valued_criteria,
    accepted_paper_emphasis: seed.accepted_paper_emphasis,
    format_rules: { ...seed.rules, required_sections: [...seed.rules.required_sections], unresolved: [] },
    source: 'seed',
    source_url: seed.guide_url || seed.cfp_url,
    updated_at: SEED_AS_OF,
  }
}

/** The CFP passages to index for a seeded venue, used by rules_lookup. */
export function seedCorpus(resolved: ResolvedVenue): { id: string; text: string; source: string }[] {
  const seed = seedFor(resolved.family)
  if (!seed) return []
  return seed.corpus.map((text, i) => ({
    id: `${resolved.venue_id}-seed-${i}`,
    text,
    source: seed.guide_url || seed.cfp_url,
  }))
}

/**
 * Best-guess CFP URL for the human-in-the-loop confirmation question.
 *
 * `venueField` must be only what the user wrote as the target conference — not
 * the whole prompt. Scanning the prompt would pick up the first URL in the
 * manuscript (a repository link, a dataset link) and propose ingesting that as
 * if it were the venue's call-for-papers.
 */
export function guessCfpUrl(resolved: ResolvedVenue, venueField: string): string | null {
  const explicit = venueField.match(/https?:\/\/\S+/)?.[0]
  if (explicit) return explicit.replace(/[).,]+$/, '')
  const seed = seedFor(resolved.family)
  return seed ? seed.guide_url || seed.cfp_url : null
}
