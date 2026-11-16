// 发表渠道与 CCF 等级。渠道决定等级：这里按简称记，下面的别名把 OpenAlex 等给出的全称认成简称。
// 等级依 CCF 2026 年第七版推荐目录；Nature / Science / TMLR 等不在目录里，记作 "-"（无评级）。
// 想补充或更正，在插件设置的「补充或更正渠道等级」里写，一行一个：渠道名=等级。
const VENUE_RANK = {
  NeurIPS: 'A', ICML: 'A', ICLR: 'A', AAAI: 'A', ACL: 'A', CVPR: 'A',
  ICCV: 'A', IJCAI: 'B', SIGIR: 'A', OSDI: 'A', SOSP: 'A', EuroSys: 'A',
  ISSTA: 'A', SC: 'A', UIST: 'A', NAACL: 'B', EMNLP: 'B', EACL: 'B',
  COLING: 'B', AAMAS: 'B', ECML: 'B', ECCV: 'B',
  JMLR: 'A', TPAMI: 'A', IJCV: 'A', AI: 'A',
  'Machine Learning': 'B', 'Neural Computation': 'B', TACL: 'B', Neurocomputing: 'C',
  Nature: '-', Science: '-', TMLR: '-', COLM: '-', CoRL: '-',
  AISTATS: '-', MLSys: '-', arXiv: '-', 'Transformer Circuits': '-',
};
// 期刊与预印本；其余按会议算。
const JOURNALS = new Set(['JMLR', 'TPAMI', 'IJCV', 'AI', 'Neural Computation', 'Nature',
  'Science', 'TMLR', 'TACL', 'Machine Learning', 'PNAS', 'Neurocomputing']);
const PREPRINTS = new Set(['arXiv', 'Transformer Circuits', 'OpenAI', 'Anthropic', 'bioRxiv', 'medRxiv', 'SSRN']);
// CCF-A 里和 AI / ML 相关的核心渠道：还没有收录论文的，在「CCF-A」里提示「未覆盖」。
const CORE_A = ['NeurIPS', 'ICML', 'ICLR', 'AAAI', 'ACL', 'CVPR', 'ICCV', 'JMLR', 'TPAMI', 'IJCV', 'AI'];

// 全称里出现这些说法，就是对应的渠道。写在前面的先认（更具体的在前）。
const VENUE_ALIASES = [
  ['north american chapter of the association for computational linguistics', 'NAACL'],
  ['european chapter of the association for computational linguistics', 'EACL'],
  ['transactions of the association for computational linguistics', 'TACL'],
  ['empirical methods in natural language processing', 'EMNLP'],
  ['international conference on computational linguistics', 'COLING'],
  ['meeting of the association for computational linguistics', 'ACL'],
  ['neural information processing systems', 'NeurIPS'],
  ['international conference on machine learning', 'ICML'],
  ['international conference on learning representations', 'ICLR'],
  ['aaai conference on artificial intelligence', 'AAAI'],
  ['computer vision and pattern recognition', 'CVPR'],
  ['international conference on computer vision', 'ICCV'],
  ['european conference on computer vision', 'ECCV'],
  ['international joint conference on artificial intelligence', 'IJCAI'],
  ['research and development in information retrieval', 'SIGIR'],
  ['operating systems design and implementation', 'OSDI'],
  ['symposium on operating systems principles', 'SOSP'],
  ['european conference on computer systems', 'EuroSys'],
  ['software testing and analysis', 'ISSTA'],
  ['high performance computing networking storage and analysis', 'SC'],
  ['user interface software and technology', 'UIST'],
  ['autonomous agents and multiagent systems', 'AAMAS'],
  ['autonomous agents and multi agent systems', 'AAMAS'],
  ['european conference on machine learning', 'ECML'],
  ['journal of machine learning research', 'JMLR'],
  ['transactions on pattern analysis and machine intelligence', 'TPAMI'],
  ['international journal of computer vision', 'IJCV'],
  ['transactions on machine learning research', 'TMLR'],
  ['conference on language modeling', 'COLM'],
  ['conference on robot learning', 'CoRL'],
  ['artificial intelligence and statistics', 'AISTATS'],
  ['machine learning and systems', 'MLSys'],
  ['transformer circuits', 'Transformer Circuits'],
  ['arxiv', 'arXiv'],
  ['biorxiv', 'bioRxiv'],
  ['medrxiv', 'medRxiv'],
];
// 只有整个名字就是它时才算（不然 “Nature Communications” 会被认成 Nature）。
const VENUE_EXACT = {
  'artificial intelligence': 'AI',
  'machine learning': 'Machine Learning',
  'neural computation': 'Neural Computation',
  neurocomputing: 'Neurocomputing',
  nature: 'Nature',
  science: 'Science',
  nips: 'NeurIPS',
  'proceedings of the national academy of sciences': 'PNAS',
};
