// One-time code extraction. This is the part of the mail integration that must not
// guess: a wrong code spends a verification attempt, and enough of them lock the
// application. Every fixture below is a realistic board message — the Greenhouse one is
// shaped from the real submit-time gate captured in state/dumps/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestCode, declaredLength, extractCodes, looksLikeVerification } from '../src/mail/codes.js';
import { classify, isJobMail } from '../src/mail/classify.js';
import type { MailMessage } from '../src/mail/types.js';

const msg = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: '1',
  account: 'tech',
  mailbox: 'gabriel.chaves.tech@gmail.com',
  from: 'iFood <no-reply@us.greenhouse-mail.io>',
  to: 'gabriel.chaves.tech@gmail.com',
  subject: 'Seu código de verificação',
  date: new Date().toISOString(),
  snippet: '',
  ...over,
});

// The real wording, as captured from the iFood/Stone submit gate.
const GREENHOUSE_BODY =
  'Um código de verificação foi enviado para gabriel.chaves.tech@gmail.com. ' +
  'Para enviar sua inscrição, digite o código de 8 caracteres para confirmar que você é uma pessoa. ' +
  'K7M2QP4X';

test('reads the 8-character code from a real Greenhouse verification mail', () => {
  const codes = extractCodes(msg({ snippet: GREENHOUSE_BODY }));
  assert.ok(codes.length > 0, 'should find a candidate');
  assert.equal(codes[0].code, 'K7M2QP4X');
  assert.equal(codes[0].shape, 'alnum-8');
  assert.ok(codes[0].confidence >= 80, `confidence should be high, got ${codes[0].confidence}`);
  assert.equal(codes[0].message.mailbox, 'gabriel.chaves.tech@gmail.com');
});

test('reads a numeric 8-character code and prefers it over a 6-digit distractor', () => {
  const body =
    'Your verification code is 48192037. This code expires in 6 minutes. ' +
    'Did you know? 123456 people applied last year.';
  const codes = extractCodes(msg({ subject: 'Your verification code', snippet: body }));
  assert.equal(codes[0].code, '48192037');
});

test('reads a 6-digit passwordless sign-in code', () => {
  const codes = extractCodes(
    msg({
      from: 'Gupy <nao-responda@gupy.io>',
      subject: 'Seu código de acesso',
      snippet: 'Use o código 604821 para entrar na sua conta. Ele expira em 10 minutos.',
    }),
  );
  assert.equal(codes[0].code, '604821');
  assert.equal(codes[0].shape, 'digits-6');
});

// The failure that matters: reading the applicant's own phone number, CPF, salary or a
// date out of the mail body and typing it into the board.
test('never mistakes a phone number, CPF, salary, date or URL for a code', () => {
  const noise = [
    'Telefone +55 (11) 94614-0288.',
    'CPF 484.629.078-61',
    'Pretensão R$ 5.200,00',
    'Data de nascimento 22/05/2004',
    'Site https://ifood.com.br/vagas/8901054002',
    'Processo 2026',
  ].join(' ');
  const codes = extractCodes(msg({ subject: 'Sobre sua candidatura', snippet: noise }));
  assert.deepEqual(codes, [], 'nothing in that text is a code');
});

test('a code is not read out of a message that is not about verification', () => {
  const codes = extractCodes(
    msg({ subject: 'Novidades da semana', snippet: 'Confira as 12345678 vagas abertas e o cupom 87654321.' }),
  );
  assert.deepEqual(codes, []);
});

test('the declared length promotes the right candidate and demotes the others', () => {
  assert.equal(declaredLength('digite o código de 8 caracteres'), 8);
  assert.equal(declaredLength('8-digit verification code'), 8);
  assert.equal(declaredLength('use o código 1234'), null);

  const codes = extractCodes(
    msg({
      subject: 'Seu código de verificação',
      snippet: 'digite o código de 8 caracteres. Alternativas: 90210 e 4455667. Código: 4455667',
    }),
  );
  // Both 7-digit and 5-digit tokens are off by one from the declared 8; the 8-character
  // rule still wins outright because nothing here is 8 long.
  assert.ok(codes.every((c) => c.confidence < 80), 'no weak token should look certain');
});

test('a code alone on its line beats one buried in prose', () => {
  const codes = extractCodes(
    msg({
      subject: 'Seu código de verificação',
      snippet: 'Seu código de verificação chegou.\n\nQ4W7Z2L9\n\nSe não foi você, ignore este e-mail. Ref 83746291.',
    }),
  );
  assert.equal(codes[0].code, 'Q4W7Z2L9');
});

test('bestCode picks the newest among equally confident mailboxes', () => {
  const older = msg({
    id: 'a',
    account: 'personal',
    mailbox: 'gabriel.chaves.3720@gmail.com',
    date: '2026-11-10T20:00:00.000Z',
    snippet: GREENHOUSE_BODY.replace('K7M2QP4X', 'AAAA1111'),
  });
  const newer = msg({
    id: 'b',
    date: '2026-11-10T20:05:00.000Z',
    snippet: GREENHOUSE_BODY.replace('K7M2QP4X', 'BBBB2222'),
  });
  const code = bestCode([older, newer]);
  assert.equal(code?.code, 'BBBB2222');
});

test('bestCode respects the since cutoff', () => {
  const stale = msg({ date: '2026-11-10T10:00:00.000Z', snippet: GREENHOUSE_BODY });
  assert.equal(bestCode([stale], { since: new Date('2026-11-10T19:00:00.000Z') }), null);
});

test('minConfidence can refuse everything', () => {
  assert.equal(extractCodes(msg({ snippet: GREENHOUSE_BODY }), { minConfidence: 101 }).length, 0);
});

test('looksLikeVerification recognises Portuguese and English wording', () => {
  assert.equal(looksLikeVerification(GREENHOUSE_BODY), true);
  assert.equal(looksLikeVerification('Your one-time passcode is ready'), true);
  assert.equal(looksLikeVerification('Confira as vagas da semana'), false);
});

// --- job mail triage -------------------------------------------------------

test('classifies the mail kinds that change what to do next', () => {
  const cases: [string, string, string, string][] = [
    ['code', 'Seu código de verificação', 'digite o código de 8 caracteres', 'verification_code'],
    ['test', 'Próxima etapa: Teste Técnico', 'você foi convidado para o teste', 'assessment'],
    ['interview', 'Convite para entrevista', 'gostaríamos de agendar uma conversa', 'interview'],
    ['offer', 'Sua proposta de trabalho chegou', 'segue a proposta em anexo', 'offer'],
    ['rejection', 'Sobre sua candidatura', 'infelizmente decidimos não seguir', 'rejection'],
    ['received', 'Candidatura recebida', 'recebemos sua candidatura', 'application_received'],
    ['alert', 'Novas vagas para você', 'recomendações de vagas', 'job_alert'],
  ];
  for (const [name, subject, snippet, expected] of cases) {
    const got = classify(msg({ subject, snippet }));
    assert.equal(got.kind, expected, `${name}: expected ${expected}, got ${got.kind}`);
  }
});

test('actionable kinds carry an action, informational ones do not', () => {
  assert.match(classify(msg({ subject: 'Teste técnico' })).action, /company test/i);
  assert.equal(classify(msg({ subject: 'Candidatura recebida', snippet: 'recebemos sua candidatura' })).action, '');
});

test('isJobMail uses the configured sender list as well as the wording', () => {
  const senders = ['gupy.io', 'greenhouse.io'];
  assert.equal(isJobMail(msg({ from: 'no-reply@us.greenhouse-mail.io', subject: 'hi', snippet: '' }), senders), true);
  assert.equal(isJobMail(msg({ from: 'friend@example.com', subject: 'almoço', snippet: 'bora?' }), senders), false);
});

// Marketing and social-network mail kept landing in job categories: a Surfshark ad
// saying "this offer" became a job offer (urgency 99, top of the to-do list), and a
// LinkedIn notification whose settings blurb mentions "mensagens de recrutadores"
// became a recruiter reply.
test('marketing mail is not a job offer, however it phrases the word', () => {
  const ad = msg({
    from: 'Surfshark <info@mail.surfshark.com>',
    subject: 'Extend your plan for only $1.89/mo!',
    snippet: 'This offer will not last. Renew your subscription today.',
  });
  assert.equal(classify(ad).kind, 'other');
});

test('a real job offer is still recognised', () => {
  const real = msg({
    from: 'rh@empresa.com.br',
    subject: 'Sua proposta de trabalho',
    snippet: 'Segue a proposta formal e o contrato. Podemos conversar sobre a data de inicio.',
  });
  assert.equal(classify(real).kind, 'offer');
  assert.match(classify(real).action, /respond/i);
});

test('a social notification that merely mentions recruiters is not a recruiter reply', () => {
  const digest = msg({
    from: 'LinkedIn <messages-noreply@linkedin.com>',
    subject: 'Ver Cristiano A. - Embaixador postar e seus próximos passos',
    snippet:
      'Gabriel, dê estes próximos passos Enviaremos atualizações do LinkedIn, atualizações da sua rede, mensagens de recrutadores e mensagens promocionais a você.',
  });
  assert.equal(classify(digest).kind, 'other');
});

test('a genuine recruiter reply from a board is still caught', () => {
  const real = msg({
    from: 'Saque e Pague <no-reply@gupy.com.br>',
    subject: 'Retorno do processo seletivo - Saque e Pague',
    snippet: 'Sobre sua candidatura, gostaríamos de conversar.',
  });
  assert.equal(classify(real).kind, 'recruiter_reply');
});

// "Thank you for applying" is an acknowledgment, not an invitation. These mails
// routinely say "if selected we will invite you to an interview", and matching the bare
// word "interview" put a no-op above real company tests in the to-do list.
test('a thank-you-for-applying mail is an acknowledgment, not an interview', () => {
  const ack = msg({
    from: 'Brex <no-reply@us.greenhouse-mail.io>',
    subject: 'Gabriel, Thank You for Applying to Brex!',
    snippet:
      'Thank you for applying to Brex. Our team will review your application and, if selected, we will invite you to an interview.',
  });
  const got = classify(ack);
  assert.equal(got.kind, 'application_received');
  assert.equal(got.action, '', 'nothing to do');
});

test('a real interview invitation is still recognised', () => {
  const invite = msg({
    from: 'rh@empresa.com.br',
    subject: 'Convite para entrevista',
    snippet: 'Gostaríamos de conversar com você. Qual a sua disponibilidade para agendar?',
  });
  assert.equal(classify(invite).kind, 'interview');
  assert.match(classify(invite).action, /interview/i);
});

test('a board confirmation of a submitted application is recognised', () => {
  const confirmed = msg({
    from: 'Stone <no-reply@us.greenhouse-mail.io>',
    subject: 'Stone | Candidatura confirmada para a vaga Software Engineer Pleno!',
    snippet: 'CONFIRMAÇÃO DA CANDIDATURA. Olá, Gabriel! Seja bem-vindo(a) ao processo seletivo.',
  });
  assert.equal(classify(confirmed).kind, 'application_received');
});

// A rejection is terminal: whatever else the message mentions, the outcome is decided.
// "Obrigado pelo interesse … optamos por seguir com outras candidaturas" was read as a
// company test, telling the candidate to sit a test that does not exist.
test('a rejection that mentions the selection process is a rejection, not a test', () => {
  const rejected = msg({
    from: 'Imediato <no-reply@gupy.com.br>',
    subject: 'Imediato (Grupo Imediato) | Obrigado pelo interesse em fazer parte do nosso time!',
    snippet:
      'Nova mensagem referente à vaga Analista de Suporte Pl. Agradecemos muito o seu interesse e por ter participado do processo seletivo. Após uma análise cuidadosa, optamos por seguir com candidaturas que se alinham mais aos requisitos da posição.',
  });
  const got = classify(rejected);
  assert.equal(got.kind, 'rejection');
  assert.equal(got.action, '', 'a rejection asks nothing of the candidate');
});

test('an acknowledgment that merely says thank-you-for-your-interest is not a rejection', () => {
  const ack = msg({
    from: 'Empresa <no-reply@gupy.com.br>',
    subject: 'Candidatura recebida',
    snippet: 'Obrigado pelo seu interesse. Recebemos sua candidatura e vamos avaliar seu perfil.',
  });
  assert.notEqual(classify(ack).kind, 'rejection');
});

// Assessment platforms mail their own codes to confirm that previous test scores are
// reused. They look like ATS verification codes but are answered on the platform's site,
// so "enter the code to finish the application" sends the candidate to the wrong place.
test('a Mindsight test-reuse code is not an application verification code', () => {
  const reuse = msg({
    from: 'Mindsight <nao-responda@mindsight.com.br>',
    subject: 'Código de confirmação Mindsight',
    snippet:
      'Seu código de confirmação chegou. Para confirmar o reaproveitamento das suas notas para o novo processo seletivo utilize o código a seguir: 334687',
  });
  const got = classify(reuse);
  assert.equal(got.kind, 'test_reuse');
  assert.match(got.action, /test platform/i);
});

test('a real ATS verification code is still a verification code', () => {
  const gate = msg({
    from: 'Greenhouse <no-reply@us.greenhouse-mail.io>',
    subject: 'Security code for your application to Brex',
    snippet: 'Copy and paste this code into the security code field on your application: 95341813',
  });
  assert.equal(classify(gate).kind, 'verification_code');
});

test('a reuse confirmation receipt asks for nothing; a reuse code does', () => {
  const receipt = msg({
    from: 'Mindsight <noreply@mg.mindsight.com.br>',
    subject: 'Os seus testes Mindsight foram reaproveitados com sucesso.',
    snippet: 'Gostaríamos de confirmar que foram reaproveitados os resultados dos seguintes testes: Teste de Cultura - Externo.',
  });
  assert.equal(classify(receipt).kind, 'test_reuse');
  assert.equal(classify(receipt).action, '', 'a receipt is not a task');

  const code = msg({
    from: 'Mindsight <noreply@mg.mindsight.com.br>',
    subject: 'Código de confirmação Mindsight',
    snippet: 'Para confirmar o reaproveitamento das suas notas utilize o código a seguir: 334687',
  });
  assert.notEqual(classify(code).action, '');
});
