import { APPLICANT_WORDING, parseListingText } from "../../core/matcher.mjs";
import type { Eligibility, TriState } from "../listings/types";

export interface ApplicantFacts {
  body?: string | null;
  restrictions?: string[] | null;
  student_allowed?: boolean | null;
  working_only?: boolean | null;
  degree_restriction?: string | null;
  couples_allowed?: boolean | null;
  pets_allowed?: boolean | null;
  evidence?: Record<string, string | undefined>;
  source_preferences?: { tenants?: number | null; occupation?: string[] };
  extraction_warnings?: string[];
}

const studentsOnly = APPLICANT_WORDING.studentsOnly;
const noStudents = /\b(?:no students|students (?:are )?(?:not allowed|not accepted|excluded)|geen studenten)\b/i;
const singleTenant = /\b(?:single (?:occupancy|tenant)|(?:1|one|één) (?:person|persoon|tenant)\b|(?:max\.?|maximum)\s*(?:of\s*)?(?:1|one|één)\b)\b/i;
const noCouples = APPLICANT_WORDING.couplesNo;
const yesCouples = APPLICANT_WORDING.couplesYes;
const noPets = APPLICANT_WORDING.petsNo;
const yesPets = APPLICANT_WORDING.petsYes;
const degreeGroups = {
  bsc: "(?:bachelor(?:'?s)?|bsc)(?: students?)?",
  msc: "(?:master(?:'?s)?|msc|graduates?)(?: students?)?",
  phd: "phds?(?: students?)?|doctoral students?|promovendi",
  professional: "(?:working )?professionals?|werkenden",
};
const audience = Object.values(degreeGroups).map((group) => `(?:${group})`).join("|");
const connector = "(?:\\s*,\\s*|\\s*(?:,?\\s+(?:and|or|en|of)\\s+|/\\s*))";
const audienceList = `(?:${audience})(?:${connector}(?:${audience}))*`;
const restrictedAudience = new RegExp(`\\b(?:${audienceList})\\s+only\\b|\\b(?:only (?:for )?|(?:alleen|uitsluitend) (?:voor )?)(?:${audienceList})\\b`, "gi");

function stated(yes: boolean, no: boolean): TriState {
  return yes === no ? "unknown" : yes ? "yes" : "no";
}

function explicitAudience(text: string, group: string) {
  const item = `(?:${group})`;
  const welcome = "(?:welcome|allowed|eligible|accepted)";
  return stated(
    new RegExp(`\\b${item}(?:${connector}(?:${audience}))*\\s+(?:are\\s+)?${welcome}\\b|\\b(?:for|accepts?|open to)\\s+${item}\\b`, "i").test(text)
      || new RegExp(`\\b(?:${audience}${connector})+${item}\\s+(?:are\\s+)?${welcome}\\b`, "i").test(text),
    new RegExp(`\\b(?:no|geen)\\s+${item}\\b|\\b${item}\\s+(?:are\\s+)?(?:not (?:allowed|welcome|accepted|eligible)|excluded)\\b`, "i").test(text),
  );
}

function onlyApplicantTypes(text: string) {
  const matches = [...text.matchAll(restrictedAudience)].map((match) => match[0]);
  if (!matches.length) return null;
  return {
    bsc: matches.some((match) => new RegExp(`\\b(?:${degreeGroups.bsc})\\b`, "i").test(match)),
    msc: matches.some((match) => new RegExp(`\\b(?:${degreeGroups.msc})\\b`, "i").test(match)),
    phd: matches.some((match) => new RegExp(`\\b(?:${degreeGroups.phd})\\b`, "i").test(match)),
    professional: matches.some((match) => new RegExp(`\\b(?:${degreeGroups.professional})\\b`, "i").test(match)),
  };
}

export function listingEligibility(facts: ApplicantFacts): Eligibility {
  const text = [...facts.restrictions ?? [], facts.body ?? ""].join("\n");
  const parsed = parseListingText(text);
  const evidence = [facts.evidence?.student_allowed, facts.evidence?.working_only].join(" ");
  const nativeTenant = evidence.match(/HousingAnywhere tenant type:\s*([^.]+)/i)?.[1];
  const occupation = facts.source_preferences?.occupation ?? [];
  const capacity = facts.source_preferences?.tenants;
  const structuredStudents = /(?:ROOMMATCH contract type:|Kamernet ideal tenant occupations)/i.test(evidence) || occupation.includes("Student");
  const native = nativeTenant?.toLowerCase();
  const workerOnly = facts.working_only === true || parsed.working_only === true || native === "working professionals only";
  const only = onlyApplicantTypes(text);
  const onlyStudents = native === "students only" || (!only && studentsOnly.test(text)) || /ROOMMATCH contract type:.*campuscontract/i.test(evidence);
  const postgrad = (facts.degree_restriction ?? parsed.degree_restriction) === "postgraduate";
  const student = facts.student_allowed ?? parsed.student_allowed;
  const studentYes = student === true || structuredStudents || onlyStudents || native === "students and working professionals";
  const studentNo = student === false || workerOnly || noStudents.test(text);
  const degreeConflict = facts.extraction_warnings?.some((warning) => /(?:tenant type|description).*differ.*students are accepted/i.test(warning));

  const bsc = explicitAudience(text, degreeGroups.bsc);
  const msc = explicitAudience(text, degreeGroups.msc);
  const phd = explicitAudience(text, degreeGroups.phd);
  const phdException = APPLICANT_WORDING.phdYes.test(text);
  const professional = explicitAudience(text, degreeGroups.professional);
  const acceptsBachelors = only?.bsc ?? ((!postgrad && studentYes) || bsc === "yes");
  const acceptsMasters = only?.msc ?? (studentYes || postgrad || msc === "yes");
  const acceptsDoctoral = only?.phd ?? (phd === "yes" || phdException || (postgrad && /\b(?:phd|postdoc)\b/i.test(text)));
  const acceptsProfessionals = only?.professional ?? (
    workerOnly || native === "students and working professionals" || occupation.includes("Working") || professional === "yes" || APPLICANT_WORDING.workingYes.test(text)
  );

  const textPet = APPLICANT_WORDING.petsYes.test(text) || APPLICANT_WORDING.petsNo.test(text);
  const textCouple = APPLICANT_WORDING.couplesYes.test(text) || APPLICANT_WORDING.couplesNo.test(text);
  const structuredPet = typeof facts.pets_allowed === "boolean" && (!textPet || /^(?:Public Kamernet|HousingAnywhere)/i.test(facts.evidence?.pets_allowed ?? ""));
  const structuredCouple = typeof facts.couples_allowed === "boolean" && !textCouple;
  return {
    tenants: degreeConflict ? { bsc: "unknown", msc: "unknown", phd: "unknown", professional: "unknown" } : {
      bsc: stated(acceptsBachelors, studentNo || postgrad || only?.bsc === false || bsc === "no"),
      msc: stated(acceptsMasters, studentNo || only?.msc === false || msc === "no"),
      phd: stated(acceptsDoctoral, phd === "no" || APPLICANT_WORDING.phdNo.test(text) || (workerOnly && !only?.phd && !phdException) || only?.phd === false),
      professional: stated(acceptsProfessionals, onlyStudents || only?.professional === false || professional === "no"),
    },
    couples: stated(facts.couples_allowed === true || yesCouples.test(text), facts.couples_allowed === false || capacity === 1 || singleTenant.test(text) || noCouples.test(text)),
    pets: facts.extraction_warnings?.some((warning) => /disagree on pets/i.test(warning)) ? "unknown" :
      stated(facts.pets_allowed === true || yesPets.test(text), facts.pets_allowed === false || noPets.test(text)),
    basis: native || structuredStudents || occupation.includes("Working") || capacity === 1 ||
      structuredCouple || structuredPet ? "structured" : "text",
  };
}

export function applicantRestrictions(facts: ApplicantFacts) {
  const fragments = (facts.body ?? "").split(/\r?\n|(?<=[.!?])\s+/);
  const explicit = [studentsOnly, noStudents, singleTenant, noCouples, yesCouples, noPets, yesPets,
    /\b(?:women|men|females?|males?|working professionals?) only\b|\b(?:graduate|bachelor|master'?s?|phds?)\b.{0,50}\b(?:welcome|allowed|accepted)\b/i];
  const labels = [
    ...facts.restrictions ?? [],
    ...fragments.filter((line) => line.length <= 240 && explicit.some((pattern) => pattern.test(line))),
    facts.degree_restriction === "postgraduate" ? "Postgraduate applicants" : null,
    facts.working_only === true ? "Working applicants only" : null,
    facts.student_allowed === false ? "Students excluded" : null,
    facts.source_preferences?.tenants === 1 ? "1 person" : null,
    /^Public Kamernet pets allowed/i.test(facts.evidence?.pets_allowed ?? "") ? (facts.pets_allowed ? "Pets allowed" : "No pets") : null,
    ...["student_allowed", "working_only", "degree_restriction", "income_requirement", "languages_required", "age_min"]
      .map((key) => facts.evidence?.[key] ?? "")
      .filter((line) => /^(?:HousingAnywhere tenant type:|ROOMMATCH contract type:)/i.test(line)),
  ];
  return [...new Set(labels.filter((label): label is string => Boolean(label?.trim())))];
}
