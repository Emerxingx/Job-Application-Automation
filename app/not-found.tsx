import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-2 py-16 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-slate-600">
        <Link href="/" className="font-medium text-red-700 hover:underline">
          Return to dashboard
        </Link>
      </p>
    </div>
  );
}
