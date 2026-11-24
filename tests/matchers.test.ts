import { test } from 'node:test';
import assert from 'node:assert/strict';
import { match } from '../src/fill/core.js';

// Cases carried over from jobsearch/tools/test-matchers.js: real Greenhouse
// labels read off a live iFood form, standard EN vocabulary, and expected BR/Gupy
// vocabulary.
const CASES: [string, string][] = [
  ['Nome*', 'first_name'],
  ['Sobrenome*', 'last_name'],
  ['Nome de preferência', 'preferred_name'],
  ['E-mail*', 'email'],
  ['País*', 'country'],
  ['Telefone*', 'phone'],
  ['Localização (Cidade)*', 'city'],
  ['Você é uma Pessoa com Deficiência?*', 'pcd'],
  ['Empresa Atual / Última Empresa*', 'current_company'],
  ['Cargo Atual / Último Cargo*', 'current_title'],
  ['LinkedIn*', 'linkedin'],
  ['Quais são os seus pronomes?*', 'pronouns'],
  ['Onde você descobriu a vaga?*', 'how_did_you_hear'],
  ['Você já trabalhou no iFood?*', 'previously_worked_here'],
  ['Qual é a sua pretensão salarial?*', 'salary_expectation'],
  ['Você possui CNH?*', 'drivers_license'],

  ['First Name', 'first_name'],
  ['Last Name', 'last_name'],
  ['Email', 'email'],
  ['Phone', 'phone'],
  ['LinkedIn Profile', 'linkedin'],
  ['GitHub', 'github'],
  ['Website / Portfolio', 'portfolio'],
  ['City', 'city'],
  ['Country', 'country'],
  ['Desired Salary', 'salary_expectation'],
  ['When can you start?', 'availability'],
  ['Notice period', 'notice_period'],
  ['Are you legally authorized to work?', 'authorized_to_work'],
  ['Will you require sponsorship?', 'requires_sponsorship'],
  ['Are you willing to relocate?', 'willing_to_relocate'],
  ['How did you hear about us?', 'how_did_you_hear'],
  ['Years of experience', 'years_of_experience'],

  ['CPF', 'cpf'],
  ['RG', 'rg'],
  ['Data de nascimento', 'date_of_birth'],
  ['CEP', 'cep'],
  ['Bairro', 'neighborhood'],
  ['Cidade', 'city'],
  ['Estado (UF)', 'state'],
  ['Pretensão salarial', 'salary_expectation'],
  ['Disponibilidade para início', 'availability'],
  ['Autodeclaração de cor/raça', 'racial_declaration'],
  ['Escolaridade', 'highest_education'],
  ['Nome completo', 'full_name'],
  ['Gênero', 'gender'],
  ['Sexo', 'gender'],
  ['Situação militar', 'military_service'],
  ['Certificado de reservista', 'military_service'],
  ['Possui CNH?', 'drivers_license'],
];

test('label heuristics match real form labels', () => {
  const failures: string[] = [];
  for (const [label, expected] of CASES) {
    const got = match(label)?.key ?? null;
    if (got !== expected) failures.push(`"${label}" => expected ${expected}, got ${got}`);
  }
  assert.deepEqual(failures, []);
});

test('specific beats general: "Nome de preferência" is not first_name', () => {
  assert.equal(match('Nome de preferência')?.key, 'preferred_name');
  assert.equal(match('Sobrenome')?.key, 'last_name');
});

test('exclusions: a technology-qualified years question is refused', () => {
  assert.equal(match('Quantos anos de experiência você tem com Kubernetes?'), null);
});

test('hybrid availability has its own key and is never start availability', () => {
  // Previously dropped entirely so a start-date field could not be answered "Sim".
  // It now has a dedicated standing answer; the invariant that survives is that it
  // must never be mistaken for a start date.
  const m = match('Você tem disponibilidade para o modelo híbrido?');
  assert.equal(m?.key, 'accepts_hybrid');
  assert.notEqual(m?.key, 'availability');
  assert.equal(match('Você possui disponibilidade para atuar no modelo híbrido, com presença no escritório em São Paulo?')?.key, 'accepts_hybrid');
  assert.equal(match('Qual é a sua disponibilidade de início?')?.key, 'availability');
});

test('salary history phrasings are current_salary, not expectation', () => {
  for (const q of [
    'Qual sua última remuneração?',
    'Qual o valor da sua última remuneração?',
    'Qual foi ou é atualmente sua remuneração?',
    'Informe seu salário bruto atual ou último:',
    'Qual é o seu salário atual?',
    '4. Poderia compartilhar conosco a sua remuneração atual?',
  ]) {
    assert.equal(match(q)?.key, 'current_salary', q);
  }
  // A target number is a different number from a current one.
  assert.equal(match('1. Qual é a sua pretensão salarial?')?.key, 'salary_expectation');
  assert.equal(match('Expectativa de remuneração')?.key, 'salary_expectation');
});

test('a multi-select of tools already used is not "previously worked here"', () => {
  // This used to answer "Não" to an inventory question — a wrong answer written
  // to the page, not merely a miss.
  assert.equal(match('4. Com quais dos ambientes e recursos abaixo você já trabalhou'), null);
  assert.equal(match('Você já trabalhou no Grupo Vivara?')?.key, 'previously_worked_here');
  assert.equal(match('Você já foi nosso colaborador?')?.key, 'previously_worked_here');
});

test('word boundaries: "privacidade" must not match city', () => {
  assert.notEqual(match('Aceito a política de privacidade')?.key, 'city');
});

test('exclusions: birth place is not date_of_birth', () => {
  assert.notEqual(match('Qual é a sua cidade e estado de nascimento?')?.key, 'date_of_birth');
  assert.notEqual(match('Qual é a sua cidade e estado de nascimento?')?.key, 'city');
  assert.equal(match('Data de nascimento')?.key, 'date_of_birth');
});

test('new KB facts: birth place, CLT experience, relatives', () => {
  assert.equal(match('Qual é a sua cidade e estado de nascimento?')?.key, 'birth_place');
  assert.equal(match('Local de nascimento')?.key, 'birth_place');
  assert.equal(match('Naturalidade')?.key, 'birth_place');
  assert.equal(match('Qual é o seu tempo de experiência CLT na área de tecnologia?')?.key, 'years_clt');
  assert.equal(match('Você possui algum familiar ou parente que trabalha na empresa?')?.key, 'relatives_at_company');
});
