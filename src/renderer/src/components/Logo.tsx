import markUrl from '../assets/magpie.png'

/**
 * La marque, rendue comme **masque** plutôt que comme image.
 *
 * L'élément est un aplat de `currentColor` découpé à la forme de l'oiseau : la marque
 * hérite donc de la couleur du texte, et devient sombre en thème clair comme claire en
 * thème sombre, sans qu'il y ait deux fichiers à tenir synchronisés.
 *
 * Le PNG est produit par `npm run logo` à partir de `icons/icon.png`.
 */
export function Logo({ size = 24 }: { size?: number }): React.JSX.Element {
  return (
    <span
      className="logo"
      aria-hidden
      style={
        {
          width: size,
          height: size,
          '--mark': `url(${markUrl})`
        } as React.CSSProperties
      }
    />
  )
}
