# Three transferable repository patterns

The reference repository treats these as separate practices. First, parse untrusted request bodies and identifiers at the HTTP boundary; malformed identifiers are client errors while well-formed absent identifiers are not-found results. Second, keep user-controlled values out of HTML interpolation by using an escaping or text-node boundary. Third, prove both adapters with deterministic, checked-in fixtures that include happy paths and representative failures.

Each practice can be adopted independently. Plans should preserve the responsible layer and may use focused child analysis, but the final implementation plan should coordinate shared fixtures and validation without moving boundary behavior into domain logic.
