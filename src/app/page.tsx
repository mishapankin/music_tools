import Link from "next/link";

const utils = [
  {
    href: "/visualizer",
    title: "Piano Visualizer",
    description: "Visualize music with falling notes",
  },
];

export default function Home() {
  return (
    <main className="bg-zinc-950 min-h-screen text-white">
      <section className="mx-auto px-6 sm:px-8 py-16 w-full max-w-3xl">
        <header className="mb-12">
          <h1 className="font-semibold text-4xl sm:text-5xl tracking-tight">
            Music Utils
          </h1>
          <p className="mt-3 text-zinc-400">
            A set of interactive music tools.
          </p>
        </header>

        <ul className="space-y-4">
          {utils.map((util) => (
            <li key={util.href}>
              <Link
                href={util.href}
                className="block bg-zinc-900 px-5 py-4 border border-zinc-800 hover:border-zinc-600 rounded-lg transition-colors"
              >
                <h2 className="font-medium text-white text-xl">
                  {util.title}
                </h2>
                <p className="mt-1 text-zinc-400 text-sm">
                  {util.description}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
