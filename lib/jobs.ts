import type { Job, JobType } from "./types";

/**
 * Seed job postings for Canada's job market.
 *
 * This is placeholder data so the app has something real to search, view,
 * and track end-to-end. Companies are fictional — nothing here should be
 * treated as a real posting or applied to.
 *
 * To wire up a live source, swap the implementations of `searchJobs` and
 * `getJobById` below for calls to a real provider (e.g. the Job Bank of
 * Canada API, or a job-search API such as Indeed's) while keeping the same
 * function signatures — nothing else in the app needs to change.
 */
export const MOCK_JOBS: Job[] = [
  {
    id: "swe-backend-northwind-toronto",
    title: "Software Engineer, Backend",
    company: "Northwind Analytics Inc.",
    location: "Toronto, ON",
    remote: false,
    type: "full-time",
    salaryRange: "$95,000 – $120,000 CAD",
    postedAt: "2026-08-25",
    description:
      "Northwind Analytics is looking for a backend engineer to help build the data pipelines that power our " +
      "retail analytics platform. You'll design APIs, own services in production, and work closely with data " +
      "scientists to ship features that customers rely on daily.",
    requirements: [
      "3+ years building production backend services",
      "Strong proficiency in TypeScript or Go",
      "Experience with PostgreSQL and message queues",
      "Comfortable owning a service from design through on-call support",
    ],
    applyUrl: "#",
    source: "Job Bank Canada",
  },
  {
    id: "data-analyst-borealis-ottawa",
    title: "Senior Data Analyst",
    company: "Borealis Health Technologies",
    location: "Ottawa, ON",
    remote: true,
    type: "full-time",
    salaryRange: "$85,000 – $105,000 CAD",
    postedAt: "2026-08-20",
    description:
      "Join Borealis Health's analytics team to turn clinical operations data into insights that improve patient " +
      "outcomes. You'll partner with product and clinical teams to build dashboards, run ad-hoc analyses, and " +
      "shape how the company measures success.",
    requirements: [
      "4+ years in a data analyst or BI role",
      "Advanced SQL and experience with a BI tool (Looker, Tableau, or similar)",
      "Comfortable presenting findings to non-technical stakeholders",
      "Healthcare or regulated-industry experience is a plus",
    ],
    applyUrl: "#",
    source: "Indeed",
  },
  {
    id: "pm-growth-maplecloud-vancouver",
    title: "Product Manager, Growth",
    company: "Maple Cloud Systems",
    location: "Vancouver, BC",
    remote: false,
    type: "full-time",
    salaryRange: "$110,000 – $135,000 CAD",
    postedAt: "2026-08-27",
    description:
      "Maple Cloud Systems is hiring a growth PM to own acquisition and activation for our SMB SaaS product. " +
      "You'll run experiments end-to-end, work with design and engineering, and report directly to the VP of " +
      "Product.",
    requirements: [
      "3+ years of product management experience",
      "Track record of running and analyzing A/B tests",
      "Strong written communication — you'll write specs and share results widely",
      "SaaS or B2B experience preferred",
    ],
    applyUrl: "#",
    source: "LinkedIn",
  },
  {
    id: "devops-frontier-montreal",
    title: "DevOps Engineer",
    company: "Frontier Robotics Co.",
    location: "Montreal, QC",
    remote: true,
    type: "full-time",
    salaryRange: "$100,000 – $125,000 CAD",
    postedAt: "2026-08-18",
    description:
      "Frontier Robotics builds autonomous warehouse robots, and our fleet telemetry infrastructure needs to be " +
      "rock solid. As a DevOps engineer you'll own CI/CD, Kubernetes infrastructure, and observability across a " +
      "growing set of services.",
    requirements: [
      "Hands-on experience with Kubernetes and Terraform",
      "Experience running CI/CD pipelines at scale",
      "Familiarity with observability stacks (Prometheus/Grafana or similar)",
      "Bilingual (English/French) is an asset but not required",
    ],
    applyUrl: "#",
    source: "Indeed",
  },
  {
    id: "ux-designer-lumen-calgary",
    title: "UX/UI Designer",
    company: "Lumen Retail Group",
    location: "Calgary, AB",
    remote: false,
    type: "full-time",
    salaryRange: "$75,000 – $95,000 CAD",
    postedAt: "2026-08-12",
    description:
      "Lumen Retail Group is redesigning its e-commerce experience for millions of Canadian shoppers. We're " +
      "looking for a designer who can move fluidly between research, wireframes, and polished high-fidelity " +
      "screens.",
    requirements: [
      "Portfolio showing end-to-end product design work",
      "Proficiency in Figma",
      "Experience running or contributing to user research",
      "E-commerce or retail experience is a plus",
    ],
    applyUrl: "#",
    source: "Job Bank Canada",
  },
  {
    id: "ml-engineer-northwind-remote",
    title: "Machine Learning Engineer",
    company: "Northwind Analytics Inc.",
    location: "Remote (Canada)",
    remote: true,
    type: "full-time",
    salaryRange: "$120,000 – $150,000 CAD",
    postedAt: "2026-08-24",
    description:
      "Help build the forecasting models behind Northwind's retail analytics product. You'll take models from " +
      "prototype to production, working closely with backend engineers to serve predictions at scale.",
    requirements: [
      "Experience shipping ML models to production",
      "Strong Python skills; comfortable with PyTorch or similar",
      "Understanding of MLOps practices (versioning, monitoring, retraining)",
      "Prior work with time-series or forecasting problems is a plus",
    ],
    applyUrl: "#",
    source: "LinkedIn",
  },
  {
    id: "marketing-coordinator-harborview-halifax",
    title: "Marketing Coordinator",
    company: "Harborview Media Inc.",
    location: "Halifax, NS",
    remote: false,
    type: "full-time",
    salaryRange: "$50,000 – $60,000 CAD",
    postedAt: "2026-08-15",
    description:
      "Harborview Media is looking for an organized, creative marketing coordinator to support campaign " +
      "execution across email, social, and events for our Atlantic Canada client roster.",
    requirements: [
      "1-3 years of marketing or communications experience",
      "Comfortable with email platforms and social scheduling tools",
      "Strong writing and proofreading skills",
      "Event coordination experience is a plus",
    ],
    applyUrl: "#",
    source: "Indeed",
  },
  {
    id: "csm-cloudnine-toronto",
    title: "Customer Success Manager",
    company: "CloudNine SaaS Corp.",
    location: "Toronto, ON",
    remote: true,
    type: "full-time",
    salaryRange: "$70,000 – $85,000 CAD",
    postedAt: "2026-08-22",
    description:
      "As a Customer Success Manager at CloudNine, you'll own a book of mid-market accounts, driving adoption, " +
      "renewals, and expansion. You'll be the customer's advocate internally and their trusted partner externally.",
    requirements: [
      "2+ years in customer success or account management at a SaaS company",
      "Comfortable owning renewal and expansion targets",
      "Excellent verbal and written communication skills",
      "Experience with a CRM such as Salesforce or HubSpot",
    ],
    applyUrl: "#",
    source: "Job Bank Canada",
  },
  {
    id: "financial-analyst-cascadia-vancouver",
    title: "Financial Analyst",
    company: "Cascadia Capital Partners",
    location: "Vancouver, BC",
    remote: false,
    type: "full-time",
    salaryRange: "$65,000 – $80,000 CAD",
    postedAt: "2026-08-11",
    description:
      "Cascadia Capital Partners is hiring a financial analyst to support budgeting, forecasting, and investor " +
      "reporting for our portfolio companies. You'll work closely with finance leads across several small and " +
      "mid-sized businesses.",
    requirements: [
      "Bachelor's degree in Finance, Accounting, or related field",
      "Advanced Excel skills; financial modeling experience",
      "CPA or working toward one is an asset",
      "Strong attention to detail",
    ],
    applyUrl: "#",
    source: "Indeed",
  },
  {
    id: "rn-beacon-winnipeg",
    title: "Registered Nurse — Medical/Surgical Unit",
    company: "Beacon Health Network",
    location: "Winnipeg, MB",
    remote: false,
    type: "full-time",
    salaryRange: "$78,000 – $92,000 CAD",
    postedAt: "2026-08-19",
    description:
      "Beacon Health Network is seeking a compassionate, detail-oriented Registered Nurse to join our " +
      "medical/surgical unit. You'll provide direct patient care, collaborate with a multidisciplinary team, and " +
      "help maintain our high standard of patient safety.",
    requirements: [
      "Current RN license in good standing (Manitoba)",
      "1+ years of med/surg or acute care experience preferred",
      "BLS certification required; ACLS an asset",
      "Strong communication and teamwork skills",
    ],
    applyUrl: "#",
    source: "Job Bank Canada",
  },
  {
    id: "mech-engineer-ironwood-hamilton",
    title: "Mechanical Engineer",
    company: "Ironwood Manufacturing Ltd.",
    location: "Hamilton, ON",
    remote: false,
    type: "full-time",
    salaryRange: "$80,000 – $98,000 CAD",
    postedAt: "2026-08-14",
    description:
      "Ironwood Manufacturing designs precision components for the automotive supply chain. We're looking for a " +
      "mechanical engineer to support product design, tolerance analysis, and production troubleshooting on our " +
      "shop floor.",
    requirements: [
      "Bachelor's degree in Mechanical Engineering",
      "Experience with CAD software (SolidWorks or similar)",
      "Understanding of GD&T and manufacturing processes",
      "P.Eng. or working toward it is an asset",
    ],
    applyUrl: "#",
    source: "Indeed",
  },
  {
    id: "admin-assistant-summit-ottawa",
    title: "Administrative Assistant (Part-Time)",
    company: "Summit Legal Group",
    location: "Ottawa, ON",
    remote: false,
    type: "part-time",
    salaryRange: "$22 – $26 CAD/hour",
    postedAt: "2026-08-26",
    description:
      "Summit Legal Group is looking for a reliable, organized administrative assistant to support our small " +
      "downtown Ottawa office 20-25 hours per week — scheduling, correspondence, and general office support.",
    requirements: [
      "1+ years of administrative experience",
      "Proficiency with Microsoft Office / Google Workspace",
      "Excellent organizational skills and attention to detail",
      "Legal or professional-services office experience is a plus",
    ],
    applyUrl: "#",
    source: "Indeed",
  },
  {
    id: "sales-rep-northernlights-edmonton",
    title: "Sales Representative",
    company: "Northern Lights Insurance",
    location: "Edmonton, AB",
    remote: false,
    type: "full-time",
    salaryRange: "$55,000 base + commission CAD",
    postedAt: "2026-08-13",
    description:
      "Northern Lights Insurance is growing its Edmonton team and looking for a driven sales representative to " +
      "build client relationships and grow a book of personal and commercial insurance business.",
    requirements: [
      "1+ years of sales experience (insurance experience a plus, not required)",
      "Alberta general insurance license, or willingness to obtain one",
      "Strong interpersonal and negotiation skills",
      "Self-motivated with a track record of hitting targets",
    ],
    applyUrl: "#",
    source: "LinkedIn",
  },
  {
    id: "frontend-intern-maplecloud-waterloo",
    title: "Frontend Developer Intern",
    company: "Maple Cloud Systems",
    location: "Waterloo, ON",
    remote: false,
    type: "internship",
    salaryRange: "$25 CAD/hour",
    postedAt: "2026-08-28",
    description:
      "A 4-month internship on Maple Cloud's web platform team. You'll ship real features alongside senior " +
      "engineers, working in React and TypeScript on customer-facing product surfaces.",
    requirements: [
      "Currently enrolled in a Computer Science or related program",
      "Coursework or personal projects using React or a similar framework",
      "Comfortable with Git and collaborative code review",
      "Available for a 4-month term",
    ],
    applyUrl: "#",
    source: "Job Bank Canada",
  },
  {
    id: "supply-chain-greatlakes-mississauga",
    title: "Supply Chain Coordinator",
    company: "Great Lakes Logistics Inc.",
    location: "Mississauga, ON",
    remote: false,
    type: "full-time",
    salaryRange: "$60,000 – $72,000 CAD",
    postedAt: "2026-08-17",
    description:
      "Great Lakes Logistics is hiring a supply chain coordinator to manage inbound shipments, coordinate with " +
      "carriers, and keep inventory data accurate across our Mississauga distribution centre.",
    requirements: [
      "2+ years of supply chain, logistics, or inventory experience",
      "Comfortable with ERP or warehouse management systems",
      "Strong Excel skills",
      "Clear, proactive communicator",
    ],
    applyUrl: "#",
    source: "Indeed",
  },
];

export interface JobSearchParams {
  q?: string;
  location?: string;
  type?: JobType | "all";
}

export function searchJobs({ q, location, type }: JobSearchParams): Job[] {
  const query = q?.trim().toLowerCase();
  const loc = location?.trim().toLowerCase();

  return MOCK_JOBS.filter((job) => {
    if (query) {
      const haystack = `${job.title} ${job.company} ${job.description}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    if (loc) {
      const isRemoteQuery = loc.includes("remote");
      const matchesLocation = job.location.toLowerCase().includes(loc);
      if (!matchesLocation && !(isRemoteQuery && job.remote)) return false;
    }

    if (type && type !== "all" && job.type !== type) return false;

    return true;
  }).sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
}

export function getJobById(id: string): Job | undefined {
  return MOCK_JOBS.find((job) => job.id === id);
}
