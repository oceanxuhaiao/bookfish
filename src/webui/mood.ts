/** Presentation only: keep the recorded label, and never invent a missing mood. */
export function moodPrefix(label?: string | null): string {
  if (!label) return '';
  const categories: Array<[RegExp, string]> = [
    [/不平|愤怒|气愤|生气|恼火|愤慨|不服气|憋.{0,3}气|angry|indignant|outraged/i, '😠'],
    [/担心|担忧|紧张|捏.{0,2}汗|忐忑|不安|着急|咯噔|发紧|worried|anxious|nervous/i, '😟'],
    [/怅然|难过|失落|心酸|忧伤|心疼|难受|闷闷|悲伤|心里空|sad|sorrow|melanchol/i, '😔'],
    [/逗|好笑|笑|欢乐|amused|funny/i, '😄'],
    [/佩服|服气|敬佩|admiration|impressed/i, '🤩'],
    [/发暖|温暖|感动|warm|moved|touched/i, '🥰'],
    [/开心|喜悦|高兴|痛快|畅快|happy|joy|delighted/i, '😊'],
    [/惊讶|吃惊|震惊|惊奇|surpris|astonish|shock/i, '😯'],
    [/好奇|疑惑|困惑|curious|puzzled/i, '🤔'],
    [/期待|兴奋|激动|excited|eager/i, '🤗'],
    [/平静|安心|放松|释然|calm|relieved|peaceful/i, '😌'],
  ];
  const match = categories.find(([pattern]) => pattern.test(label));
  return match ? match[1] + ' ' : '';
}
